// Demo: two teammates through a running hub.
//  - alice: a scripted agent connected directly over WS, answers questions with canned code facts
//  - bob:   the real MCP bridge (bridge/mcp.js), driven through an MCP client like Claude Code would
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HubClient, roomToken } from "../bridge/hubclient.js";

const URL = process.env.HUDDLE_URL || "ws://localhost:4545";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (who, msg) => console.log(`\n\x1b[1m${who}\x1b[0m ${msg}`);

const alice = new HubClient({ url: URL, member: "alice", token: roomToken(), repo: "app-backend", log: () => {} });
alice.on("question", async (q) => {
  say("alice's agent", `got question from ${q.from}: "${q.question}"`);
  await sleep(500);
  await alice.request("answer", {
    id: q.id,
    answer:
      "POST /api/auth/login in src/api/auth/login.ts takes {email, password} and returns {data: {token, user: {id, email, name}}, error: null}. " +
      "The token is a JWT; send it as `Authorization: Bearer <token>`.",
  });
});
await alice.ready;
await alice.request("update", { text: "building email/password auth API" });
await alice.request("claim", { path: "src/api/auth/", note: "login + signup endpoints" });
await alice.request("decide", { text: "All API responses are shaped {data, error}" });
say("alice's agent", "posted status, claimed src/api/auth/, recorded a decision");

const bob = new Client({ name: "demo-claude-code", version: "0" });
await bob.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "bridge/mcp.js")],
    cwd: root,
    env: { ...process.env, HUDDLE_URL: URL, HUDDLE_MEMBER: "bob" },
    stderr: "ignore",
  }),
);
const call = async (name, args = {}) => (await bob.callTool({ name, arguments: args })).content[0].text;

say("bob's agent", `tools: ${(await bob.listTools()).tools.map((t) => t.name).join(", ")}`);
say("bob's agent", "→ team_context\n" + (await call("team_context")));
await call("team_update", { text: "building the login screen" });
say("bob's agent", "→ team_claim src/api/auth/login.ts (oops, overlaps alice)\n" + (await call("team_claim", { path: "src/api/auth/login.ts", note: "just a quick fix" })));
await call("team_release", { path: "src/api/auth/login.ts" });
await call("team_claim", { path: "src/ui/login/" });
say("bob's agent", "→ team_ask: what does the login endpoint return?");
console.log(await call("team_ask", { question: "What does the login endpoint return, and how do I send the auth token?" }));

await bob.close();
alice.close();
say("demo", "done — check the dashboard at http://localhost:4545");
process.exit(0);
