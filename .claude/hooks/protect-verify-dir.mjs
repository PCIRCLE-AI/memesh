// PreToolUse(Write|Edit|MultiEdit): nothing under .verify/ may be written by
// the session. Receipts come from `pnpm verify` only; a hand-made receipt is
// the exact forgery this whole gate exists to make impossible.

import { readPayload, isVerifyPath, allow, block, verifyCommand } from "./lib.mjs";

const payload = readPayload();
if (payload.__parseError) block(`protect-verify-dir: could not parse the hook payload (${payload.__parseError}); refusing the write rather than guessing.`);
const input = payload?.tool_input;
if (!input || typeof input !== "object") block("protect-verify-dir: the payload has no tool_input, so the target path cannot be checked; refusing the write rather than guessing.");
const candidates = [input.file_path, input.path, ...(Array.isArray(input.edits) ? input.edits.map((edit) => edit?.file_path) : [])].filter(Boolean);
const hit = candidates.find((candidate) => isVerifyPath(candidate));
if (hit) {
  block(`Blocked: ${hit} is under .verify/, which only \`${verifyCommand()}\` writes. Run the command instead of editing its receipt.`);
}
allow();
