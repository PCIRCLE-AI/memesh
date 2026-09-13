// Shared CLI plumbing for the SDLC loop's standalone scripts: read a
// `--flag value` argument, and tell whether this file was run directly
// (`node script.mjs`) rather than imported.
//
// Kept out of lib.mjs on purpose: .claude/hooks/hooks.test.mjs copies only
// scripts/sdlc/lib.mjs into a scratch repo for the hooks to import, so
// lib.mjs must not gain an import this file doesn't carry with it.

import path from "node:path";
import { fileURLToPath } from "node:url";

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}
