"use client";

import { useEffect, useState } from "react";

// Shapes the hub sends; see snapshot() and logEvent() in hub/server.js.
export type Member = {
  name: string;
  repo: string;
  agent: string;
  status: string;
  online: boolean;
  lastSeen: number;
  autorespond: boolean;
};
export type Claim = { path: string; member: string; note: string; at: number };
export type Decision = { id: string; text: string; by: string; at: number };
export type HubEvent = {
  id: string;
  kind: string;
  member: string;
  text: string;
  at: number;
  thread?: string;
  to?: string;
  path?: string;
  note?: string;
  with?: string;
  otherPath?: string;
  repo?: string;
  replaced?: boolean;
  live?: boolean; // set here, not by the hub: arrived after the page loaded
};
export type Snapshot = {
  members: Member[];
  claims: Claim[];
  decisions: Decision[];
  events: HubEvent[];
  inbox: Record<string, number>;
  bridge: string;
};
export type Connection = "connecting" | "live" | "reconnecting" | "locked";

const MAX_EVENTS = 2000; // the hub keeps the same number

// The room password arrives in the link the hub prints (#token=…) and is kept for this tab only.
function readToken() {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("token");
  let stored = "";
  try {
    if (fromLink) sessionStorage.setItem("huddle-token", fromLink);
    stored = sessionStorage.getItem("huddle-token") || "";
  } catch {}
  // Once it's stored, take it out of the address bar so it isn't on screen during a demo.
  if (fromLink && stored === fromLink) history.replaceState(null, "", location.pathname + location.search);
  return fromLink || stored;
}

export function useHub() {
  const [token, setToken] = useState<string | null>(null); // null until read from the page address
  const [host, setHost] = useState("");
  const [conn, setConn] = useState<Connection>("connecting");
  const [state, setState] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<HubEvent[]>([]);

  useEffect(() => {
    setToken(readToken());
    setHost(location.host);
  }, []);

  useEffect(() => {
    if (token === null) return;
    // Without the room password the page shows nothing but how to get in.
    if (!token) return setConn("locked");
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;
    let refreshTimer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        try {
          const r = await fetch("/api/state", { headers: { "x-huddle-token": token } });
          if (r.status === 401) return setConn("locked");
          if (r.ok && !stopped) setState(await r.json());
        } catch {} // the socket notices a dead hub and reconnects
      }, 150);
    };
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/?role=viewer&token=${encodeURIComponent(token)}`);
      ws.onopen = () => setConn("live");
      ws.onclose = (e) => {
        if (stopped) return;
        if (e.code === 4001) return setConn("locked");
        setConn("reconnecting");
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === "snapshot") {
          setState(msg.data);
          setEvents(msg.data.events);
        }
        if (msg.type === "event") {
          setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), { ...msg.event, live: true }]);
          refresh();
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(refreshTimer);
      ws.close();
    };
  }, [token]);

  return { token: token ?? "", host, conn, state, events };
}

export async function askHub(token: string, question: string): Promise<string> {
  const r = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", "x-huddle-token": token },
    body: JSON.stringify({ question }),
  });
  if (r.status === 401) throw new Error("The hub rejected this page’s room password. Open the dashboard link from the hub’s terminal again.");
  if (!r.ok) throw new Error(`The hub returned an error (${r.status}). Check the hub’s terminal.`);
  return (await r.json()).answer;
}
