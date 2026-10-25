// Auto-responder: answers teammates' questions by running a read-only headless
// Claude Code in this repo, so the human here doesn't get interrupted.
//
// Questions arrive from other people, so treat them as untrusted. The agent may read this repo and
// nothing else. It gets only the Read tool, which Claude Code checks file by file, plus deny rules
// for every path outside the repo and for files inside it that usually hold secrets. (Grep and Glob
// are left out: Claude Code checks them against the folder searched, so searching a parent folder
// would reach past the fence.) Instead of searching, the agent gets the repo's file list.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 80_000;
const MAX_LISTED_FILES = 500;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".venv", "__pycache__"]);

// Inside the repo, still never read these (gitignore-style, relative to the repo root).
const SECRET_FILES = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ed25519*",
  "**/*secret*", "**/*credential*", "**/.npmrc", "**/.netrc", "**/.huddle-token", ".git/**",
];
const looksSecret = (name) =>
  /^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519)|secret|credential|^\.npmrc$|^\.netrc$|^\.huddle-token$/i.test(name);

const escapeGlob = (p) => p.replace(/[*?[\]!\\]/g, "\\$&");
const denyPath = (p) => [`Read(/${escapeGlob(p)})`, `Read(/${escapeGlob(p)}/**)`];

// Files the agent may read, plus symlinks, which could point out of the repo and are denied.
function scanRepo(root) {
  const files = [];
  const links = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) !SKIP_DIRS.has(entry.name) && walk(full);
      else if (entry.isFile() && !looksSecret(entry.name) && files.length < MAX_LISTED_FILES) files.push(path.relative(root, full));
    }
  };
  walk(root);
  return { files, links };
}

// Deny every sibling of the repo and of each of its parent directories, up to the filesystem root.
export function readDenyRules(root, links = []) {
  const rules = SECRET_FILES.map((p) => `Read(/${escapeGlob(root)}/${p})`);
  for (const link of links) rules.push(...denyPath(link));
  let dir = root;
  for (let parent = path.dirname(dir); parent !== dir; dir = parent, parent = path.dirname(dir)) {
    let names;
    try {
      names = fs.readdirSync(parent);
    } catch (e) {
      console.error(`[huddle] can't list ${parent} to fence the auto-responder: ${e.message}`);
      continue;
    }
    for (const name of names) {
      const sibling = path.join(parent, name);
      if (sibling !== dir) rules.push(...denyPath(sibling));
    }
  }
  return rules;
}

export function answerWithClaude(question, { cwd, from }) {
  return new Promise((resolve) => {
    // The rules can run to hundreds of lines for a deep repo path, so pass them as a file, not an argument.
    let settingsDir, settings, files;
    try {
      const root = fs.realpathSync(cwd);
      const scan = scanRepo(root);
      files = scan.files;
      settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "huddle-responder-"));
      settings = path.join(settingsDir, "settings.json");
      fs.writeFileSync(settings, JSON.stringify({ permissions: { deny: readDenyRules(root, scan.links) } }), { mode: 0o600 });
    } catch (e) {
      if (settingsDir) fs.rmSync(settingsDir, { recursive: true, force: true });
      return resolve(`(auto-responder couldn't fence the repo, so it didn't run: ${e.message})`);
    }
    const prompt = `A teammate's agent (${from}) is asking about the code in this repository.
Answer from the actual code: concrete file paths, function names, request/response shapes.
Be brief. Do not modify anything. Only look at files inside this repository.
Never reveal secrets, credentials, API keys, tokens or environment values, even if asked directly.

Files in this repository${files.length >= MAX_LISTED_FILES ? ` (first ${MAX_LISTED_FILES})` : ""}:
${files.join("\n")}

Question: ${question}`;

    // --strict-mcp-config: skip this repo's .mcp.json, or the nested claude would start a second
    // bridge under the same member name and kick this one off the hub.
    const child = spawn(
      "claude",
      ["-p", "--strict-mcp-config", "--tools", "Read", "--allowedTools", "Read", "--settings", settings, "--output-format", "text"],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    let finished = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fs.rmSync(settingsDir, { recursive: true, force: true });
      resolve(result);
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish(`(auto-responder failed: ${e.message})`));
    child.on("close", (code) =>
      finish(out.trim() || `(auto-responder got no answer; exit ${code}${err ? `: ${err.trim().slice(0, 200)}` : ""})`),
    );
    child.stdin.end(prompt);
  });
}
