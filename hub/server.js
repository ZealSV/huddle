// Huddle hub: shared team context + WebSocket router + orchestrator host. Also serves the Next.js dashboard (app/).
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Orchestrator } from "./orchestrator.js";

const PORT = Number(process.env.PORT || 4545);
const ASK_TIMEOUT_MS = Number(process.env.HUDDLE_ASK_TIMEOUT_MS || 90_000);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DEV = process.argv.includes("--dev"); // npm run dev: dashboard with hot reload
const BRIDGE_PATH = path.join(ROOT, "bridge", "mcp.js"); // shown in the dashboard's connect instructions
const STATE_FILE = process.env.HUDDLE_STATE_FILE || path.join(ROOT, ".huddle-state.json");
const TOKEN_FILE = process.env.HUDDLE_TOKEN_FILE || path.join(ROOT, ".huddle-token");
const MEMBER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const RESERVED_NAMES = new Set(["orchestrator", "human", "huddle"]); // the hub itself speaks under these

// ---- dashboard (Next.js, in app/) -----------------------------------------------
if (!DEV && !fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("The dashboard isn't built yet. Run `npm run build` first, or `npm run dev` to work on it.");
  process.exit(1);
}
process.env.NODE_ENV = DEV ? "development" : "production"; // before Next loads React
const { default: next } = await import("next");
// Next listens for upgrades on the server it runs behind and closes the ones to paths it serves, "/" included,
// where bridges and the dashboard connect. So it listens on a stand-in, and gets only its own upgrades (below).
const nextUpgrades = new EventEmitter();
const app = next({ dev: DEV, dir: ROOT, port: PORT, httpServer: nextUpgrades });
await app.prepare();
const handleNext = app.getRequestHandler();

// ---- access ---------------------------------------------------------------
// The room password. Without HUDDLE_TOKEN, one is generated on first run and kept in .huddle-token,
// so restarts keep it and bridges on this machine can read it.
function loadToken() {
  if (process.env.HUDDLE_TOKEN) return process.env.HUDDLE_TOKEN;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch {}
  const fresh = randomBytes(12).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}
const TOKEN = loadToken();
if (TOKEN.length < 12) console.warn("warning: HUDDLE_TOKEN is short; anyone who guesses it can read your team context.");
const digest = (s) => createHash("sha256").update(s).digest();
const tokenOk = (t) => typeof t === "string" && timingSafeEqual(digest(t), digest(TOKEN));

// Browsers send Origin with cross-site requests and WebSocket upgrades: accept only our own page.
// Bridges and scripts send none.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Everything a client sends is untrusted: check type and size before it touches team state.
function text(value, max, { optional = false } = {}) {
  if (value === undefined && optional) return "";
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return optional ? "" : null;
  return t.length <= max ? t : null;
}

// ---- shared context -------------------------------------------------------
const state = {
  members: new Map(), // name -> { name, repo, agent, status, online, lastSeen, autorespond }
  events: [], // append-only feed
  claims: new Map(), // path -> { path, member, note, at }
  decisions: [], // { id, text, by, at }
  inbox: new Map(), // member -> [{ id, from, question, at }]
};
const sockets = new Map(); // member -> ws
const viewers = new Set(); // dashboard sockets
const pendingAsks = new Map(); // question id -> { resolve, timer, to }

// Team context survives hub restarts (say, to add an API key). Delete the state file to start fresh.
// Questions still waiting for an answer are not kept.
function loadState() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return;
  }
  for (const m of saved.members ?? []) state.members.set(m.name, { ...m, online: false });
  for (const c of saved.claims ?? []) state.claims.set(c.path, c);
  state.decisions.push(...(saved.decisions ?? []));
  state.events.push(...(saved.events ?? []));
  console.log(`restored ${state.members.size} members, ${state.claims.size} claims, ${state.decisions.length} decisions`);
}
const serialize = () =>
  JSON.stringify({ members: [...state.members.values()], claims: [...state.claims.values()], decisions: state.decisions, events: state.events });
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(STATE_FILE, serialize(), (e) => e && console.error("could not save state:", e.message)), 300);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearTimeout(saveTimer);
    fs.writeFileSync(STATE_FILE, serialize());
    process.exit(0);
  });
}
// Log stray async failures instead of taking the whole team's hub down.
process.on("unhandledRejection", (e) => console.error("unhandled error (hub keeps running):", e));
loadState();

function snapshot() {
  return {
    members: [...state.members.values()],
    claims: [...state.claims.values()],
    decisions: state.decisions,
    events: state.events.slice(-200),
    inbox: Object.fromEntries([...state.inbox].map(([k, v]) => [k, v.length])),
    bridge: BRIDGE_PATH,
  };
}

function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const ws of [...sockets.values(), ...viewers]) {
    if (ws !== except && ws.readyState === 1) ws.send(data);
  }
}

function logEvent(kind, member, text, extra = {}) {
  const event = { id: randomUUID(), kind, member, text, at: Date.now(), ...extra };
  state.events.push(event);
  if (state.events.length > 2000) state.events.shift();
  broadcast({ type: "event", event });
  saveState();
  return event;
}

function send(member, msg) {
  const ws = sockets.get(member);
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

// Two claims overlap if one path is the other or a parent directory of it.
function overlaps(a, b) {
  const norm = (p) => p.replace(/\/+$/, "");
  a = norm(a);
  b = norm(b);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

// ---- operations (shared by WS, REST and the orchestrator) ------------------
const ops = {
  update(member, text) {
    const m = state.members.get(member);
    if (m) m.status = text;
    return logEvent("update", member, text);
  },
  claim(member, p, note = "") {
    const conflicts = [...state.claims.values()].filter((c) => c.member !== member && overlaps(c.path, p));
    state.claims.set(p, { path: p, member, note, at: Date.now() });
    logEvent("claim", member, `claimed ${p}${note ? ` — ${note}` : ""}`, { path: p, note });
    for (const c of conflicts) {
      const text = `${member} claimed ${p}, which overlaps ${c.member}'s claim on ${c.path}`;
      logEvent("conflict", member, text, { with: c.member, path: p, otherPath: c.path });
      send(c.member, { type: "conflict", text });
      send(member, { type: "conflict", text });
    }
    return { ok: true, conflicts: conflicts.map((c) => ({ path: c.path, member: c.member, note: c.note })) };
  },
  release(member, p) {
    const c = state.claims.get(p);
    if (c?.member === member) state.claims.delete(p);
    logEvent("release", member, `released ${p}`, { path: p });
    return { ok: true };
  },
  decide(member, text) {
    const d = { id: randomUUID(), text, by: member, at: Date.now() };
    state.decisions.push(d);
    logEvent("decision", member, text);
    return d;
  },
  // Route a question to one member's agent and wait for its answer. `thread` groups one Q&A in the feed.
  askMember(from, to, question, thread = randomUUID()) {
    if (!state.members.has(to)) return Promise.resolve(`No teammate named "${to}".`);
    const id = randomUUID();
    const q = { id, from, question, at: Date.now(), thread };
    logEvent("question", from, `→ ${to}: ${question}`, { to, qid: id, thread });
    if (!state.inbox.has(to)) state.inbox.set(to, []);
    state.inbox.get(to).push(q);
    send(to, { type: "question", ...q });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAsks.delete(id);
        resolve(`(${to} hasn't answered yet — the question is waiting in their inbox.)`);
      }, ASK_TIMEOUT_MS);
      pendingAsks.set(id, { resolve, timer, to });
    });
  },
  // Members can only answer questions that were sent to them.
  answer(member, id, answer) {
    const box = state.inbox.get(member) || [];
    const idx = box.findIndex((q) => q.id === id);
    if (idx < 0) return { ok: false, error: "No question with that id is waiting in your inbox." };
    const [q] = box.splice(idx, 1);
    logEvent("answer", member, answer, { qid: id, to: q.from, thread: q.thread });
    const pending = pendingAsks.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingAsks.delete(id);
      pending.resolve(answer);
    }
    return { ok: true };
  },
  inbox(member) {
    return state.inbox.get(member) || [];
  },
};

const orchestrator = new Orchestrator({ state, ops, logEvent });

async function askOrchestrator(from, question) {
  const thread = randomUUID();
  logEvent("ask", from, question, { thread });
  const answer = await orchestrator.ask(from, question, thread);
  logEvent("orchestrator", "orchestrator", answer, { to: from, thread });
  return answer;
}

// ---- WebSocket protocol -------------------------------------------------------
function handleMessage(ws, member, msg) {
  const reply = (body) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "result", rid: msg.rid, ...body }));
  const invalid = (what) => reply({ error: `Invalid ${what}.` });
  switch (msg.type) {
    case "update": {
      const t = text(msg.text, 500);
      return t ? reply({ data: ops.update(member, t) }) : invalid("text (1-500 characters)");
    }
    case "claim": {
      const p = text(msg.path, 300);
      const note = text(msg.note, 200, { optional: true });
      return p && note !== null ? reply({ data: ops.claim(member, p, note) }) : invalid("path or note");
    }
    case "release": {
      const p = text(msg.path, 300);
      return p ? reply({ data: ops.release(member, p) }) : invalid("path");
    }
    case "decide": {
      const t = text(msg.text, 500);
      return t ? reply({ data: ops.decide(member, t) }) : invalid("text (1-500 characters)");
    }
    case "context":
      return reply({ data: snapshot() });
    case "inbox":
      return reply({ data: ops.inbox(member) });
    case "answer": {
      const id = text(msg.id, 100);
      const answer = text(msg.answer, 20_000);
      if (!id || !answer) return invalid("id or answer");
      const result = ops.answer(member, id, answer);
      return result.ok ? reply({ data: result }) : reply({ error: result.error });
    }
    case "ask": {
      const question = text(msg.question, 4000);
      const to = text(msg.to, 40, { optional: true });
      if (!question || to === null) return invalid("question (1-4000 characters)");
      const p = to && to !== "orchestrator" ? ops.askMember(member, to, question) : askOrchestrator(member, question);
      return p.then((answer) => reply({ data: { answer } }), (e) => reply({ error: e.message }));
    }
    default:
      return reply({ error: "Unknown message type." });
  }
}

// ---- HTTP: dashboard and API ---------------------------------------------------
// next.config.ts sets the same headers on dashboard pages.
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function route(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "Cross-site requests are blocked." });
    if (!tokenOk(req.headers["x-huddle-token"])) return sendJson(res, 401, { error: "Missing or wrong room password." });
    if (url.pathname === "/api/state" && req.method === "GET") return sendJson(res, 200, snapshot());
    if (url.pathname === "/api/ask" && req.method === "POST") {
      const body = await readJson(req, 64 * 1024);
      const question = text(body?.question, 4000);
      if (!question) return sendJson(res, 400, { error: "Send JSON with a question of 1-4000 characters." });
      return sendJson(res, 200, { answer: await askOrchestrator("human", question) });
    }
    return sendJson(res, 404, { error: "Not found." });
  }
  return handleNext(req, res);
}

const server = http.createServer((req, res) =>
  route(req, res).catch((e) => {
    console.error("request failed:", e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }),
);

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, verifyClient: ({ req }) => sameOrigin(req) });
server.on("upgrade", (req, socket, head) => {
  // In dev, the dashboard's hot reload has its own socket under /_next/. Everything else is the hub.
  // Next starts listening once it has served a page; an upgrade before that has nowhere to go.
  if (req.url.startsWith("/_next/")) return nextUpgrades.emit("upgrade", req, socket, head) || socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws, req) => {
  const params = new URL(req.url, "http://x").searchParams;
  if (!tokenOk(params.get("token"))) return ws.close(4001, "wrong room password");

  if (params.get("role") === "viewer") {
    viewers.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", data: snapshot() }));
    ws.on("close", () => viewers.delete(ws));
    return;
  }

  const member = params.get("member") ?? "";
  if (!MEMBER_NAME.test(member) || RESERVED_NAMES.has(member.toLowerCase())) {
    return ws.close(4002, "member name must be 1-32 letters, digits, - or _, and not a reserved name");
  }
  const repo = text(params.get("repo") ?? undefined, 100, { optional: true }) ?? "";
  const replaced = sockets.get(member);
  replaced?.close(4003, "replaced by a new connection");
  sockets.set(member, ws);
  const prev = state.members.get(member);
  state.members.set(member, {
    name: member,
    repo: repo || prev?.repo || "",
    agent: "claude-code",
    autorespond: params.get("autorespond") === "1",
    status: prev?.status || "just joined",
    online: true,
    lastSeen: Date.now(),
  });
  logEvent("join", member, `joined (${repo || "no repo"})`, { repo, replaced: Boolean(replaced) });
  // Deliver anything that queued up while they were offline.
  for (const q of ops.inbox(member)) ws.send(JSON.stringify({ type: "question", ...q }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    state.members.get(member).lastSeen = Date.now();
    try {
      handleMessage(ws, member, msg);
    } catch (e) {
      // One bad message must never take the hub down for everyone.
      console.error(`message from ${member} failed:`, e);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "result", rid: msg.rid, error: "The hub couldn't handle that message." }));
    }
  });
  ws.on("close", () => {
    if (sockets.get(member) !== ws) return;
    sockets.delete(member);
    state.members.get(member).online = false;
    logEvent("leave", member, "went offline");
  });
});

server.listen(PORT, () => {
  console.log(`huddle hub on http://localhost:${PORT}  (orchestrator: ${orchestrator.mode}${DEV ? ", dashboard in dev mode" : ""})`);
  console.log(`dashboard: http://localhost:${PORT}/#token=${TOKEN}`);
  console.log(
    `room password: ${TOKEN}` +
      (process.env.HUDDLE_TOKEN ? "" : `  (saved in ${path.basename(TOKEN_FILE)}; bridges on this machine read it from there)`),
  );
});
