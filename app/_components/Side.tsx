"use client";

import type { Claim, Decision } from "../_lib/hub";
import { clock, label, tint, useColor } from "../_lib/team";

export default function Side({ claims, decisions }: { claims?: Claim[]; decisions?: Decision[] }) {
  const colorOf = useColor();
  return (
    <div className="side">
      <section id="claims">
        <h2>
          Claims{claims?.length ? <span>{claims.length}</span> : null}
        </h2>
        {/* Claims look like a multiplayer selection: a frame in the owner's color, tagged with their name */}
        <ul className="frames">
          {claims?.map((c) => (
            <li key={c.path} className="frame" style={tint(colorOf(c.member))}>
              <span className="tag">
                <svg viewBox="0 0 9 11" aria-hidden="true">
                  <path d="M1 1v8.2l2.3-2.1 1.5 3.3 1.6-.7-1.5-3.2H8z" fill="#fff" />
                </svg>
                {label(c.member)}
              </span>
              <code>{c.path}</code>
              {c.note && <div className="frame-note">{c.note}</div>}
            </li>
          ))}
          {claims?.length === 0 && <li className="quiet">Nothing claimed yet. Agents claim files before editing them, so nobody collides.</li>}
        </ul>
      </section>
      <section id="decisions">
        <h2>
          Decisions{decisions?.length ? <span>{decisions.length}</span> : null}
        </h2>
        <ul className="decisions">
          {decisions
            ?.slice()
            .reverse()
            .map((d) => (
              <li key={d.id}>
                <mark>{d.text}</mark>
                <span className="by">
                  {label(d.by)}, {clock(d.at)}
                </span>
              </li>
            ))}
          {decisions?.length === 0 && <li className="quiet">No decisions yet. Agreements like API shapes and naming land here.</li>}
        </ul>
      </section>
    </div>
  );
}
