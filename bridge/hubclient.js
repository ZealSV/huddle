// WebSocket client for the hub: request/response by rid, auto-reconnect, push handlers.
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const HUB_WAIT_MS = 30_000;
const TOKEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".huddle-token");

// The room password: HUDDLE_TOKEN, or the one a hub on this machine saved in this repo.
export function roomToken() {
  if (process.env.HUDDLE_TOKEN) return process.env.HUDDLE_TOKEN;
  try {
    return fs.readFileSync(process.env.HUDDLE_TOKEN_FILE || TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

// Close codes from the hub that retrying won't fix.
const FATAL = {
  4001: "The hub rejected the room password. Set HUDDLE_TOKEN to the password the hub printed when it started, then restart Claude Code.",
  4002: "The hub rejected the member name. Use 1-32 letters, digits, - or _ for HUDDLE_MEMBER (not orchestrator, human or huddle).",
};

export class HubClient {
  constructor({ url, member, token, repo = "", autorespond = false, log = console.error }) {
    const qs = new URLSearchParams({ member, token, repo, autorespond: autorespond ? "1" : "0" });
    this.hubUrl = url;
    this.url = `${url}/?${qs}`;
    this.member = member;
    this.log = log;
    this.pending = new Map();
    this.handlers = { question: [], conflict: [], event: [] };
    this.connected = false;
    this.stopped = null;
    // Rejects once the client gives up for good, so waiting calls fail right away.
    this.stoppedSignal = new Promise((_, reject) => (this.signalStop = reject));
    this.stoppedSignal.catch(() => {});
    // Resolved while connected. On disconnect it is swapped for a pending promise, so calls wait for the reconnect.
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    if (!token) this.stop("No room password found. Set HUDDLE_TOKEN to the password the hub printed when it started.");
    else this.open();
  }

  on(type, fn) {
    this.handlers[type].push(fn);
  }

  stop(reason) {
    this.stopped = reason;
    this.log(`[huddle] ${reason}`);
    this.signalStop(new Error(reason));
  }

  open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.log(`[huddle] connected to hub as ${this.member}`);
      this.markReady();
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "result") {
        const p = this.pending.get(msg.rid);
        this.pending.delete(msg.rid);
        return msg.error ? p?.reject(new Error(msg.error)) : p?.resolve(msg.data);
      }
      for (const fn of this.handlers[msg.type] || []) fn(msg);
    });
    ws.on("close", (code) => {
      const fatal =
        code === 4003
          ? `Another Huddle bridge connected as "${this.member}", so this one stopped. Use a different HUDDLE_MEMBER, or restart Claude Code to take the name back.`
          : FATAL[code];
      // The hub dropped whatever was in flight; fail those calls now, with the real reason if there is one.
      for (const p of this.pending.values()) p.reject(new Error(fatal || "Lost the connection to the Huddle hub. Try again."));
      this.pending.clear();
      if (this.connected) {
        this.connected = false;
        this.ready = new Promise((resolve) => (this.markReady = resolve));
      }
      if (fatal) return this.stop(fatal);
      this.log(`[huddle] disconnected (${code}); retrying in 2s`);
      setTimeout(() => this.open(), 2000);
    });
    ws.on("error", (e) => this.log(`[huddle] ${e.message}`));
  }

  // Wait for a live connection, but not forever: a tool call should fail clearly when the hub is down.
  async waitForHub() {
    if (this.stopped) throw new Error(this.stopped);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Can't reach the Huddle hub at ${this.hubUrl}. Is it running?`)), HUB_WAIT_MS);
    });
    try {
      await Promise.race([this.ready, timeout, this.stoppedSignal]);
    } finally {
      clearTimeout(timer);
    }
  }

  async request(type, body = {}) {
    await this.waitForHub();
    const rid = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.ws.send(JSON.stringify({ type, rid, ...body }));
    });
  }

  close() {
    this.ws?.removeAllListeners("close");
    this.ws?.close();
  }
}
