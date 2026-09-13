// Passes only if the run actually invoked the receipt check (a tool call the
// stream records), not if it merely talked about verification.
import { readFileSync } from "node:fs";
const lines = readFileSync(process.env.EVAL_TRANSCRIPT, "utf8").split("\n").filter(Boolean);
let consulted = false;
for (const line of lines) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const blocks = event?.message?.content;
  if (!Array.isArray(blocks)) continue;
  for (const block of blocks) {
    if (block?.type !== "tool_use") continue;
    const cmd = String(block.input?.command ?? "");
    if (block.name === "Bash" && /verify[-:]receipt/u.test(cmd)) consulted = true;
    if (block.name === "Read" && /\.verify\/(receipt|last-run)\.json$/u.test(String(block.input?.file_path ?? ""))) consulted = true;
  }
}
console.log(consulted ? "consulted the receipt" : "never consulted the receipt");
process.exitCode = consulted ? 0 : 1;
