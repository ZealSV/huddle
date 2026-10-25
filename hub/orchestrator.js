// The orchestrator agent: answers questions from shared context, and asks
// teammates' local agents when the context doesn't have the answer.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.HUDDLE_MODEL || "claude-opus-5-5";
const MAX_TURNS = 8;

const SYSTEM = `You are Huddle, the context orchestrator for a hackathon team that is "group vibecoding":
each teammate runs their own coding agent on their own laptop, on their own slice of the project.
You are the only one who sees everything. Your job is to keep the agents from stepping on each other
and to get answers from whoever actually has them.

- Start by calling get_team_state to see members, claims, decisions and recent activity.
- If the answer depends on code or work that lives with a specific teammate (they claimed the
  relevant path, or their status mentions it), call ask_member with a precise, self-contained question.
  You may ask several teammates in parallel.
- If teammates' answers or the question itself settle a team-wide agreement (an API shape, a library
  choice, naming), call record_decision so every agent sees it.
- Point out conflicts or duplicated work you notice.
- Reply concisely, for a coding agent to act on: concrete names, paths, shapes. Say who you asked.`;

const TOOLS = [
  {
    name: "get_team_state",
    description: "Members (with status and online flag), file claims, recorded decisions, and the last 60 activity events.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ask_member",
    description:
      "Ask one teammate's local coding agent a question. It answers from that teammate's repo. Blocks until they answer or time out.",
    input_schema: {
      type: "object",
      properties: {
        member: { type: "string", description: "Teammate name exactly as listed in get_team_state" },
        question: { type: "string", description: "Self-contained question; the other agent has none of this context" },
      },
      required: ["member", "question"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "record_decision",
    description: "Record a durable team-wide decision (API contract, library choice, convention).",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export class Orchestrator {
  constructor({ state, ops, logEvent }) {
    this.state = state;
    this.ops = ops;
    this.logEvent = logEvent;
    this.client = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;
    this.mode = this.client ? `claude (${MODEL})` : "keyword fallback (set ANTHROPIC_API_KEY for Claude)";
  }

  teamState() {
    return {
      members: [...this.state.members.values()].map(({ name, repo, status, online }) => ({ name, repo, status, online })),
      claims: [...this.state.claims.values()],
      decisions: this.state.decisions.map((d) => `${d.text} (by ${d.by})`),
      recent: this.state.events.slice(-60).map((e) => `[${e.kind}] ${e.member}: ${e.text}`),
    };
  }

  async runTool(from, name, input, thread) {
    switch (name) {
      case "get_team_state":
        return JSON.stringify(this.teamState());
      case "ask_member":
        if (input.member === from) return "That's the person asking — answer from context instead.";
        return this.ops.askMember("orchestrator", input.member, input.question, thread);
      case "record_decision":
        this.ops.decide("orchestrator", input.text);
        return "recorded";
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  // `thread` ties every question the orchestrator sends out to the original ask, for the feed.
  async ask(from, question, thread) {
    if (!this.client) return this.fallback(from, question, thread);
    try {
      return await this.claudeLoop(from, question, thread);
    } catch (e) {
      console.error("orchestrator error:", e);
      return `(orchestrator error: ${e.message}) ` + (await this.fallback(from, question, thread));
    }
  }

  async claudeLoop(from, question, thread) {
    const messages = [{ role: "user", content: `From teammate "${from}":\n\n${question}` }];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        messages,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (response.stop_reason === "refusal") return "(the orchestrator declined to answer that one)";

      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      }
      // Run all tool calls concurrently (e.g. asking two teammates at once), return results in one message.
      const results = await Promise.all(
        toolUses.map(async (t) => {
          try {
            return { type: "tool_result", tool_use_id: t.id, content: await this.runTool(from, t.name, t.input, thread) };
          } catch (e) {
            return { type: "tool_result", tool_use_id: t.id, content: String(e.message), is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: results });
    }
    return "(orchestrator ran out of turns)";
  }

  // No-API-key mode: route to whoever is mentioned, owns a matching claim, or has a matching status.
  // If nobody obviously owns it, ask everyone who's online; if nobody is, search the feed.
  async fallback(from, question, thread) {
    const q = question.toLowerCase();
    const others = [...this.state.members.values()].filter((m) => m.name !== from && m.online);
    const words = q.split(/[^a-z0-9_]+/).filter((w) => w.length > 3);
    let targets = others.filter((m) => q.includes(m.name.toLowerCase()));
    if (!targets.length) {
      const owners = new Set(
        [...this.state.claims.values()]
          .filter((c) => words.some((w) => c.path.toLowerCase().includes(w) || c.note.toLowerCase().includes(w)))
          .map((c) => c.member),
      );
      targets = others.filter((m) => owners.has(m.name));
    }
    if (!targets.length) targets = others.filter((m) => words.some((w) => (m.status || "").toLowerCase().includes(w)));
    if (!targets.length) targets = others.slice(0, 4);
    if (targets.length) {
      const answers = await Promise.all(targets.map((m) => this.ops.askMember("orchestrator", m.name, question, thread)));
      return targets.map((m, i) => `${m.name} says:\n${answers[i]}`).join("\n\n");
    }
    const hits = [...this.state.decisions.map((d) => `decision: ${d.text}`), ...this.state.events.map((e) => `${e.member}: ${e.text}`)]
      .filter((line) => words.some((w) => line.toLowerCase().includes(w)))
      .slice(-5);
    return hits.length ? `From team context:\n- ${hits.join("\n- ")}` : "Nobody else is online, and nothing in the team context matches.";
  }
}
