"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { HubEvent } from "../_lib/hub";
import { clock, isDoing, label, listOf, lower1, tidy, tint, useColor } from "../_lib/team";

const MAX_ROWS = 200;

// Feed items, ordered by last activity: plain events, and threads that collect a Q&A's events.
function group(events: HubEvent[]) {
  const items = new Map<string, HubEvent[]>();
  for (const e of events) {
    const key = e.thread ? `t-${e.thread}` : `e-${e.id}`;
    const evs = items.get(key) ?? [];
    items.delete(key);
    items.set(key, [...evs, e]);
    if (items.size > MAX_ROWS) items.delete(items.keys().next().value!);
  }
  return [...items].reverse();
}

export default function Feed({ events, loaded }: { events: HubEvent[]; loaded: boolean }) {
  const items = useMemo(() => group(events), [events]);
  return (
    <ol className="feed">
      {items.map(([key, evs]) => {
        const fresh = Boolean(evs.at(-1)!.live);
        // Keyed by length too, so an item that gets a new event re-mounts and plays its arrival again.
        return evs[0].thread ? <Thread key={`${key}:${evs.length}`} evs={evs} fresh={fresh} /> : <Row key={key} e={evs[0]} fresh={fresh} />;
      })}
      {loaded && !items.length && <li className="quiet">Nothing yet. What every agent does shows up here as it happens.</li>}
    </ol>
  );
}

function Actor({ name = "" }: { name?: string }) {
  return <b>{label(name)}</b>;
}

function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  const colorOf = useColor();
  return (
    <span className={small ? "avatar small" : "avatar"} style={tint(colorOf(name))} aria-hidden="true">
      {name === "human" ? "?" : label(name).charAt(0)}
    </span>
  );
}

// Agents answer in light markdown: render bold and inline code, show bullets and headings as plain lines.
function Markdown({ text }: { text: string }) {
  return text.split("\n").map((line, i) => (
    <Fragment key={i}>
      {i > 0 && "\n"}
      {line
        .replace(/^#{1,6} /, "")
        .replace(/^[-*] /, "• ")
        .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
        .map((part, j) => (j % 2 === 0 ? part : part.startsWith("`") ? <code key={j}>{part.slice(1, -1)}</code> : <b key={j}>{part.slice(2, -2)}</b>))}
    </Fragment>
  ));
}

function Said({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split("\n").length > 5;
  return (
    <>
      <div className={long && !open ? "said clamp" : "said"}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="link more" type="button" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

function Item({ e, fresh, children }: { e: HubEvent; fresh: boolean; children: ReactNode }) {
  return (
    <li className={fresh ? "fresh" : undefined}>
      <Avatar name={e.member} />
      <div>{children}</div>
      <time dateTime={new Date(e.at).toISOString()}>{clock(e.at)}</time>
    </li>
  );
}

const stripRoute = (t: string) => t.replace(/^→ [^:]+: /, "");

// What one event says, or null when it lacks the fields to say it (events from an older hub).
function describe(e: HubEvent): { what: ReactNode; extra?: ReactNode } | null {
  const who = <Actor name={e.member} />;
  switch (e.kind) {
    case "join":
      return {
        what: <>{who} {e.replaced ? "rejoined" : "joined"}{e.repo && <> from <span className="ink">{e.repo}</span></>}</>,
        extra: e.replaced && <div className="sub quiet">An older connection under this name was closed.</div>,
      };
    case "leave":
      return { what: <>{who} went offline</> };
    case "update": {
      const s = tidy(e.text);
      if (/^starting\s/i.test(s)) return { what: <>{who} started <span className="ink">{s.replace(/^starting\s+/i, "")}</span></> };
      if (isDoing(s)) return { what: <>{who} started <span className="ink">{lower1(s)}</span></> };
      return { what: <>{who} posted an update</>, extra: <div className="sub">{s}</div> };
    }
    case "claim":
      if (!e.path) return null;
      return { what: <>{who} claimed <code>{e.path}</code></>, extra: e.note && <div className="sub quiet">{e.note}</div> };
    case "release":
      if (!e.path) return null;
      return { what: <>{who} released <code>{e.path}</code></> };
    case "conflict":
      if (!e.path || !e.with) return null;
      return {
        what: <><span className="flag">Conflict</span>{who} claimed <code>{e.path}</code>, which overlaps <Actor name={e.with} />’s <code>{e.otherPath}</code></>,
      };
    case "decision":
      return { what: <>{who} recorded a decision</>, extra: <div className="sub"><mark>{e.text}</mark></div> };
    case "ask":
      return { what: <>{who} asked Huddle</>, extra: <Said text={e.text} /> };
    case "question":
      return { what: <>{who} asked <Actor name={e.to} /></>, extra: <Said text={stripRoute(e.text)} /> };
    case "answer":
    case "orchestrator":
      return { what: <>{who} answered <Actor name={e.to || "orchestrator"} /></>, extra: <Said text={e.text} /> };
    default:
      return null;
  }
}

// One event on its own line.
function Row({ e, fresh }: { e: HubEvent; fresh: boolean }) {
  const { what, extra } = describe(e) ?? { what: <><Actor name={e.member} /> <span className="ink">{e.text}</span></> };
  return (
    <Item e={e} fresh={fresh}>
      <div className="what">{what}</div>
      {extra}
    </Item>
  );
}

// A question plus every hop it took: who Huddle asked, who answered, and the final answer.
function Thread({ evs, fresh }: { evs: HubEvent[]; fresh: boolean }) {
  const [first] = evs;
  if (first.kind !== "ask" && first.kind !== "question") return <Row e={evs.at(-1)!} fresh={fresh} />;
  const viaHuddle = first.kind === "ask";
  const asked: string[] = [];
  const answered = new Set<string>();
  const steps: ReactNode[] = [];
  let final: HubEvent | undefined;
  for (const e of evs.slice(1)) {
    if (viaHuddle ? e.kind === "orchestrator" : e.kind === "answer") final = e;
    else if (e.kind === "question") {
      asked.push(e.to ?? "");
      steps.push(
        <li key={e.id}>
          <Avatar name={e.member} small />
          <span><Actor name={e.member} /> asked <Actor name={e.to} /></span>
        </li>,
      );
    } else if (e.kind === "answer") {
      answered.add(e.member);
      steps.push(
        <li key={e.id}>
          <Avatar name={e.member} small />
          <span><Actor name={e.member} /> answered</span>
        </li>,
      );
    }
  }
  if (!final) {
    const waitingOn = (viaHuddle ? asked : [first.to ?? ""]).filter((n) => !answered.has(n)).map(label);
    const status = waitingOn.length ? <>Waiting for {listOf(waitingOn)}…</> : viaHuddle && !asked.length ? "Huddle is looking into it…" : "Huddle is writing the answer…";
    steps.push(<li key="waiting" className="waiting">{status}</li>);
  }
  // With one teammate answering, the steps already say who, so drop the fallback's "alice says:" line.
  const finalText = (f: HubEvent) => (viaHuddle && answered.size === 1 ? f.text.replace(/^\S+ says:\n/, "") : f.text);
  return (
    <Item e={first} fresh={fresh}>
      <div className="what">
        <Actor name={first.member} /> asked {viaHuddle ? <b>Huddle</b> : <Actor name={first.to} />}
      </div>
      <Said text={viaHuddle ? first.text : stripRoute(first.text)} />
      {steps.length > 0 && <ol className="steps">{steps}</ol>}
      {final && (
        <div className="final">
          <div className="what">
            <Actor name={final.member} /> answered
          </div>
          <Said text={finalText(final)} />
        </div>
      )}
    </Item>
  );
}
