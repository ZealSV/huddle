"use client";

import { useEffect, useRef, useState } from "react";

type Props = { open: boolean; onClose: () => void; host: string; token: string; bridge?: string };

export default function ConnectDialog({ open, onClose, host, token, bridge }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cmd = useRef<HTMLPreElement>(null);
  const [copyText, setCopyText] = useState("Copy command");

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  const command = [
    "claude mcp add huddle \\",
    `  -e HUDDLE_URL=ws://${host} \\`,
    `  -e HUDDLE_TOKEN=${token} \\`,
    "  -e HUDDLE_MEMBER=your-name \\",
    "  -e HUDDLE_AUTORESPOND=1 \\",
    `  -- node "${bridge || "/path/to/cal-hacks-2026/bridge/mcp.js"}"`,
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyText("Copied");
    } catch {
      if (cmd.current) getSelection()?.selectAllChildren(cmd.current);
      setCopyText("Press ⌘C to copy");
    }
    setTimeout(() => setCopyText("Copy command"), 2000);
  }

  return (
    <dialog ref={dialog} aria-labelledby="connect-title" onClose={onClose}>
      <h2 id="connect-title">Connect an agent</h2>
      <p>
        Run this in your project folder, then start Claude Code there. Replace <code>your-name</code> with your name.
      </p>
      <pre className="cmd" ref={cmd}>
        {open ? command : ""}
      </pre>
      <p>
        The command includes this room’s password, so share it only with your team. With auto-reply on, your agent answers teammates’ questions by
        reading your repo. It can’t change anything or read files outside the repo.
      </p>
      <div className="dialog-actions">
        <button className="pill soft" type="button" onClick={onClose}>
          Close
        </button>
        <button className="pill" type="button" onClick={copy}>
          {copyText}
        </button>
      </div>
    </dialog>
  );
}
