#!/usr/bin/env node
// Huddle bridge: an MCP server your local coding agent talks to, connected to the team hub.
// stdout is the MCP channel — log only to stderr.
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubClient, roomToken } from "./hubclient.js";
import { answerWithClaude } from "./responder.js";

const cwd = process.cwd();
const member = process.env.HUDDLE_MEMBER || os.userInfo().username;
const autorespond = process.env.HUDDLE_AUTORESPOND === "1";

const hub = new HubClient({
  url: process.env.HUDDLE_URL || "ws://localhost:4545",
  token: roomToken(),
  member,
  repo: path.basename(cwd),
  autorespond,
});

// Things the hub pushed since the agent last looked; surfaced on the next tool call.
const notices = [];
hub.on("conflict", (m) => notices.push(`⚠️ CONFLICT: ${m.text}`));
hub.on("question", async (q) => {
  if (!autorespond) return notices.push(`❓ ${q.from} asked you: "${q.question}" — reply with team_answer(id="${q.id}")`);
  try {
    const answer = await answerWithClaude(q.question, { cwd, from: q.from });
    await hub.request("answer", { id: q.id, answer });
    notices.push(`ℹ️ auto-answered ${q.from}'s question "${q.question}"`);
  } catch (e) {
    // The question stays in this member's inbox, so it can still be answered with team_answer.
    console.error(`[huddle] couldn't auto-answer: ${e.message}`);
  }
});

const text = (data) => {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const extra = notices.splice(0).join("\n");
  return { content: [{ type: "text", text: extra ? `${extra}\n\n${body}` : body }] };
};

const server = new McpServer({ name: "huddle", version: "0.1.0" });

server.registerTool(
  "team_context",
  {
    description:
      "Get the shared team context: who is working on what, file claims, team decisions, and recent activity. Call before starting a task.",
    inputSchema: {},
  },
  async () => {
    const s = await hub.request("context");
    return text({
      you: member,
      members: s.members.map((m) => `${m.name}${m.online ? "" : " (offline)"} — ${m.status}`),
      claims: s.claims.map((c) => `${c.path} → ${c.member}${c.note ? ` (${c.note})` : ""}`),
      decisions: s.decisions.map((d) => d.text),
      recent: s.events.slice(-25).map((e) => `[${e.kind}] ${e.member}: ${e.text}`),
    });
  },
);

server.registerTool(
  "team_update",
  { description: "Tell the team what you're working on or just finished. Keep it to one line.", inputSchema: { text: z.string() } },
  async ({ text: t }) => (await hub.request("update", { text: t }), text("posted")),
);

server.registerTool(
  "team_claim",
  {
    description: "Claim a file or directory you're about to change, so other agents avoid it. Returns any overlapping claims.",
    inputSchema: { path: z.string().describe("repo-relative path, e.g. src/api/auth/"), note: z.string().optional() },
  },
  async ({ path: p, note }) => text(await hub.request("claim", { path: p, note })),
);

server.registerTool(
  "team_release",
  { description: "Release a claim when you're done with a path.", inputSchema: { path: z.string() } },
  async ({ path: p }) => text(await hub.request("release", { path: p })),
);

server.registerTool(
  "team_decide",
  {
    description: "Record a team-wide decision (API shape, library choice, naming convention) that every agent should follow.",
    inputSchema: { text: z.string() },
  },
  async ({ text: t }) => text(await hub.request("decide", { text: t })),
);

server.registerTool(
  "team_ask",
  {
    description:
      "Ask a question about teammates' work. By default the orchestrator answers, asking the right teammate's agent if needed. Set `to` to ask one teammate directly. May take up to ~90s.",
    inputSchema: { question: z.string(), to: z.string().optional().describe("teammate name; omit to let the orchestrator route it") },
  },
  async ({ question, to }) => text((await hub.request("ask", { question, to })).answer),
);

server.registerTool(
  "team_inbox",
  { description: "List questions teammates have asked you that are waiting for an answer.", inputSchema: {} },
  async () => text(await hub.request("inbox")),
);

server.registerTool(
  "team_answer",
  {
    description: "Answer a question from your inbox. Look at the code first and answer concretely.",
    inputSchema: { id: z.string(), answer: z.string() },
  },
  async ({ id, answer }) => text(await hub.request("answer", { id, answer })),
);

await server.connect(new StdioServerTransport());
console.error(`[huddle] MCP bridge ready (member=${member}, autorespond=${autorespond})`);
