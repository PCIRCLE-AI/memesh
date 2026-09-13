// Shared plumbing for this repo's Claude Code hooks. Each hook reads one JSON
// payload from stdin, decides from git and the filesystem only, and answers
// with an exit code: 0 allow, 2 block (stderr goes back to Claude).
//
// A hook that cannot decide fails closed and says why; a silent exit 0 would
// look identical to "checked and fine".

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

export async function loadSdlc() {
  return import(pathToFileURL(path.join(PROJECT_DIR, "scripts", "sdlc", "lib.mjs")).href);
}

// The verify command as this project spells it (`commands.verify` in
// sdlc/config.json), quoted in every gate message. Read directly so the
// message is right even before scripts/sdlc/lib.mjs is loaded.
export function verifyCommand() {
  try {
    return JSON.parse(readFileSync(path.join(PROJECT_DIR, "sdlc", "config.json"), "utf8")).commands?.verify || "node scripts/verify.mjs";
  } catch {
    return "node scripts/verify.mjs";
  }
}

export function readPayload() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    return { __parseError: String(error) };
  }
}

export function block(message) {
  process.stderr.write(`${message.trim()}\n`);
  process.exit(2);
}

export function allow(message) {
  if (message) process.stdout.write(`${message.trim()}\n`);
  process.exit(0);
}

export function sessionFile(sessionId) {
  return path.join(PROJECT_DIR, ".verify", "sessions", `${String(sessionId || "unknown").replace(/[^A-Za-z0-9_-]/gu, "_")}.json`);
}

export function isVerifyPath(filePath) {
  if (!filePath) return false;
  const abs = path.resolve(PROJECT_DIR, filePath);
  const rel = path.relative(PROJECT_DIR, abs);
  return rel === ".verify" || rel.startsWith(`.verify${path.sep}`);
}
