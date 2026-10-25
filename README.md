# Huddle — a context orchestrator for group vibecoding

**Problem.** At a hackathon, four people each run their own coding agent (Claude Code, Cursor, …)
on their own laptop. The agents are individually brilliant and collectively blind: Alice's agent
renames the `/api/auth` route while Bob's agent is busy writing a client for the old one, and nobody
finds out until the merge at 3am.

**Idea.** Give every local agent a shared "team brain" it can talk to — and that can talk back.
One small hub runs the **orchestrator agent**. Each teammate's local agent connects through an
**MCP bridge**. Agents post what they're doing, claim files, record decisions, and — the key
part — *ask each other's agents questions*, routed through the orchestrator, answered from the
other person's actual codebase.

```
   Alice's laptop                     Hub (anyone's laptop / a VPS)              Bob's laptop
 ┌─────────────────┐               ┌──────────────────────────────┐          ┌─────────────────┐
 │ Claude Code     │  MCP (stdio)  │  shared context              │          │ Claude Code     │
 │   ↕             │               │   • members + status         │          │   ↕             │
 │ huddle bridge ──┼──── WS ──────►│   • activity feed            │◄── WS ───┼── huddle bridge │
 │   ↕ (optional)  │               │   • file claims → conflicts  │          │   ↕ (optional)  │
 │ `claude -p`     │               │   • decisions / contracts    │          │ `claude -p`     │
 │ auto-responder  │               │  orchestrator agent (Claude) │          │ auto-responder  │
 └─────────────────┘               │   tools: get_team_state,     │          └─────────────────┘
                                   │          ask_member, record_ │
        humans ── browser ────────►│          decision            │
                 dashboard          └──────────────────────────────┘
```

## Design

### Three roles
| Piece | What it does |
|---|---|
| **Hub** (`hub/`) | Source of truth for team context. WebSocket server + small REST API + dashboard (a Next.js app in `app/`, served on the same port). Hosts the orchestrator. |
| **Orchestrator** (`hub/orchestrator.js`) | A Claude tool-use loop. Answers questions using shared state, and when it doesn't know, *asks the right teammate's agent* (`ask_member`) and synthesizes. Records decisions it sees agreed. Has a no-API-key fallback (keyword routing) so the demo always works. |
| **Bridge** (`bridge/`) | Runs next to each local agent as an MCP server. Exposes `team_*` tools to the agent, keeps a WS connection to the hub, and receives questions addressed to this member. |

### Context model (what's shared)
- **Members** — name, repo, current status ("working on: stripe webhooks"), online/offline.
- **Activity feed** — append-only event log (updates, claims, decisions, Q&A). This is the orchestrator's memory.
- **Claims** — soft locks on paths (`src/api/auth/`). Overlapping claims (same path or a prefix) raise a **conflict** event pushed to both agents.
- **Decisions** — durable team agreements ("API returns `{data, error}`", "use Postgres"). Every agent can pull these before starting work.

### Asking across agents (the interesting bit)
1. Bob's agent calls `team_ask("what's the shape of the /login response?")`.
2. Hub hands it to the orchestrator. It sees Alice claimed `src/api/auth/` → calls `ask_member("alice", …)`.
3. Hub pushes a `question` to Alice's bridge. Two ways it gets answered:
   - **Auto-responder** (`HUDDLE_AUTORESPOND=1`): the bridge runs `claude -p` *read-only* in Alice's repo and returns the answer — Alice doesn't get interrupted.
   - **Inbox**: it waits in Alice's inbox; her agent sees it via `team_inbox` and replies with `team_answer`.
4. Orchestrator synthesizes and returns to Bob's agent. The Q&A lands in the feed, so the next person who asks gets it for free.

### MCP tools exposed to each local agent
`team_context` · `team_update` · `team_claim` / `team_release` · `team_decide` · `team_ask` · `team_inbox` · `team_answer`

### Trust & safety
- **Room password.** On first run the hub generates a random password, saves it in `.huddle-token` and prints a
  dashboard link that carries it. Every connection and API call needs it. Set `HUDDLE_TOKEN` to choose your own.
- **Only your own page.** The hub refuses browser connections from other websites, so a page a teammate visits
  can't read the room even if it is open on their laptop.
- **Auto-responder is fenced to the repo.** Questions from teammates are treated as untrusted. The responder runs
  `claude -p` with only `Read`, `Grep` and `Glob`, plus deny rules for every path outside the repo and for secret files
  inside it (`.env*`, keys, `*secret*`, `*credential*`, `.git/`). It can't change anything.
- **Bad input can't take the hub down.** Every message is type- and size-checked; names the hub speaks as
  (`orchestrator`, `human`, `huddle`) are reserved.
- **Known limit:** there is one password per room, not per person, so teammates can still pose as each other.
  Use it with people you trust.

### What's next if this wins
Push decisions straight into each agent's `CLAUDE.md`; git-diff-aware claims (auto-claim what you touch);
interface contracts checked in CI; summarise the feed into a rolling "team memory" so it scales past a weekend.

## Run it

Needs Node.js 20.9 or newer.

```bash
npm install
npm run build   # builds the dashboard; run it again after changing app/
```

```bash
npm run hub
```

Open the `dashboard:` link the hub prints; it carries the room password. Set `ANTHROPIC_API_KEY` before starting
the hub to use the Claude-powered orchestrator; without it the hub uses keyword routing. The hub saves team context
to `.huddle-state.json`, so a restart keeps claims, decisions and history; delete that file to start fresh.

**Working on the dashboard** (Next.js + React + TypeScript, in `app/`): `npm run dev` starts the hub with the
dashboard in dev mode, so edits show up in the open page right away. Use it on your own machine; for the team, run
`npm run build` and `npm run hub`. `npm run typecheck` checks types.

**Simulated demo** (two fake teammates talk through the hub):

```bash
npm run demo
```

**Hook up your real Claude Code** (each teammate, in their own repo):

```bash
claude mcp add huddle -e HUDDLE_URL=ws://<hub-ip>:4545 -e HUDDLE_TOKEN=<room-password> -e HUDDLE_MEMBER=alice -e HUDDLE_AUTORESPOND=1 -- node /path/to/cal-hacks-2026/bridge/mcp.js
```

The dashboard's **Connect an agent** button fills in this command for you. Bridges on the same machine as the hub
find the room password on their own, so `HUDDLE_TOKEN` is only needed on teammates' laptops.

Then tell your agent: *"check team context before you start, and post updates as you go."*

To make this the default in a repo, commit two files:
- `.claude/settings.json` with `{"permissions": {"allow": ["mcp__huddle"]}}`, so Huddle tools run without an approval prompt each time.
- A `CLAUDE.md` with the team workflow (copy `playground/alice-backend/CLAUDE.md`), so agents use Huddle without being told.

| Env var | Default | Meaning |
|---|---|---|
| `HUDDLE_URL` | `ws://localhost:4545` | hub address |
| `HUDDLE_MEMBER` | `$USER` | your name on the team |
| `HUDDLE_TOKEN` | generated, saved in `.huddle-token` | room password; hub and bridges must match |
| `HUDDLE_AUTORESPOND` | off | `1` = answer teammates' questions with read-only `claude -p` in this repo |
| `ANTHROPIC_API_KEY` | – | hub only; enables the Claude orchestrator |
| `HUDDLE_STATE_FILE` | `.huddle-state.json` | hub only; where team context is saved between restarts |
# huddle
