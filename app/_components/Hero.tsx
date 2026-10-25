"use client";

import { Fragment, type ReactNode } from "react";
import type { Member } from "../_lib/hub";
import { isDoing, label, listOf, lower1, tidy, tint, useColor } from "../_lib/team";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

type Props = { members?: Member[]; locked: boolean; onConnect: () => void; children: ReactNode };

// The team's state, written as sentences.
export default function Hero({ members, locked, onConnect, children }: Props) {
  let headline: string;
  let parts: ReactNode[] = [];
  if (locked) {
    headline = "Open the dashboard link from the hub’s terminal.";
    parts = ["It carries this room’s password. Look for the line that starts with “dashboard:”."];
  } else if (!members) {
    headline = "Connecting to the hub…";
  } else {
    const on = members.filter((m) => m.online);
    const off = members.filter((m) => !m.online);
    const offNames = listOf(off.map((m) => <Who key={m.name} m={m} />));
    if (!members.length) {
      headline = "No one’s here yet.";
      parts = [
        <>
          Connect a coding agent and it shows up here.{" "}
          <button className="link inline" type="button" onClick={onConnect}>
            Show me how
          </button>
        </>,
      ];
    } else if (!on.length) {
      headline = "Everyone’s offline.";
      parts = [<>{offNames} {off.length === 1 ? "was" : "were"} here earlier.</>];
    } else {
      headline = `${WORDS[on.length] ?? on.length} ${on.length === 1 ? "agent" : "agents"} online.`;
      parts = on.map((m) => <Doing m={m} />);
      if (off.length) parts.push(<>{offNames} {off.length === 1 ? "is" : "are"} offline.</>);
    }
  }

  return (
    <section className="hero">
      <h1>{headline}</h1>
      <p>
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && " "}
            {part}
          </Fragment>
        ))}
      </p>
      {children}
    </section>
  );
}

function Who({ m }: { m: Member }) {
  const colorOf = useColor();
  const title = `${m.repo || "no repo"}${m.autorespond ? ", answers questions automatically" : ""}`;
  return (
    <span className={m.online ? "who" : "who away"} style={tint(colorOf(m.name))} title={title}>
      {label(m.name)}
    </span>
  );
}

// First sentence only, so a long status doesn't take over the hero.
function brief(s: string) {
  const first = String(s ?? "").trim().split(/(?<=\.)\s+/)[0];
  return first.length > 90 ? `${first.slice(0, 88).trimEnd()}…` : first;
}

function Doing({ m }: { m: Member }) {
  const s = tidy(brief(m.status));
  if (!s || s === "just joined") return <><Who m={m} /> just joined.</>;
  if (isDoing(s)) return <><Who m={m} /> is {lower1(s)}.</>;
  return <><Who m={m} /> posted “{s}”.</>;
}
