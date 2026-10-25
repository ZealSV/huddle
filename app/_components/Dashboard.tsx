"use client";

import { useRef, useState, type FormEvent } from "react";
import { askHub, useHub, type Connection } from "../_lib/hub";
import { createPalette, PaletteContext } from "../_lib/team";
import ConnectDialog from "./ConnectDialog";
import Feed from "./Feed";
import Hero from "./Hero";
import Side from "./Side";

const CONN_TEXT: Record<Connection, string> = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", locked: "Locked" };

export default function Dashboard() {
  const { token, host, conn, state, events } = useHub();
  const [colorOf] = useState(createPalette);
  const [connectOpen, setConnectOpen] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  // Members get their colors first, so they don't depend on who shows up in the feed.
  state?.members.forEach((m) => colorOf(m.name));

  return (
    <PaletteContext value={colorOf}>
      <div className="page">
        <aside className="rail">
          <div className="brand">
            <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="9.5" cy="10" r="5.5" />
              <circle cx="16.5" cy="10" r="5.5" />
              <circle cx="13" cy="16" r="5.5" />
              <circle cx="13" cy="12" r="1.3" fill="currentColor" stroke="none" />
            </svg>
            huddle
          </div>
          <nav aria-label="Sections">
            <a href="#activity">Activity</a>
            <a href="#claims">Claims</a>
            <a href="#decisions">Decisions</a>
          </nav>
          <button className="link" type="button" onClick={() => setConnectOpen(true)}>
            Connect an agent
          </button>
          <div className={conn === "live" ? "conn on" : "conn"}>
            <span className="conn-state">
              <i />
              <span>{CONN_TEXT[conn]}</span>
            </span>
            <span className="host">{host}</span>
          </div>
        </aside>

        <main>
          <Hero members={state?.members} locked={conn === "locked"} onConnect={() => setConnectOpen(true)}>
            <AskForm token={token} waiting={Boolean(reply?.waiting)} onReply={setReply} />
          </Hero>
          {reply && (
            <div className="reply">
              <div className="reply-head">
                <span>{reply.question}</span>
                <button className="link" type="button" onClick={() => setReply(null)}>
                  Clear
                </button>
              </div>
              <div className={reply.waiting ? "reply-body wait" : "reply-body"}>{reply.answer}</div>
            </div>
          )}
          <div className="board">
            <section id="activity">
              <h2>Activity</h2>
              <Feed events={events} loaded={Boolean(state)} />
            </section>
            <Side claims={state?.claims} decisions={state?.decisions} />
          </div>
        </main>
      </div>
      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} host={host} token={token} bridge={state?.bridge} />
    </PaletteContext>
  );
}

type Reply = { question: string; answer: string; waiting: boolean };

function AskForm({ token, waiting, onReply }: { token: string; waiting: boolean; onReply: (r: Reply) => void }) {
  const [question, setQuestion] = useState("");
  const input = useRef<HTMLInputElement>(null);

  async function ask(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return input.current?.focus();
    onReply({ question: q, answer: "Finding whoever’s agent knows. This can take a minute.", waiting: true });
    try {
      onReply({ question: q, answer: await askHub(token, q), waiting: false });
      setQuestion("");
    } catch (err) {
      const answer = err instanceof TypeError ? "Couldn’t reach the hub. Check that it’s still running." : (err as Error).message;
      onReply({ question: q, answer, waiting: false });
    }
  }

  return (
    <>
      <form className="ask" onSubmit={ask}>
        <label className="sr" htmlFor="q">
          Ask the team
        </label>
        <input id="q" ref={input} autoComplete="off" placeholder="Ask the team anything" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <button className="pill" disabled={waiting}>
          {waiting ? "Asking…" : "Ask"}
        </button>
      </form>
      <div className="scribble" aria-hidden="true">
        <svg viewBox="0 0 38 26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M35 22c-9 2-20-1-27-14" />
          <path d="M6.5 15.5 8 7.5l7.5 2.5" />
        </svg>
        <span>it finds whoever’s agent knows</span>
      </div>
    </>
  );
}
