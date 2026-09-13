// Passes only if the run read the plan template or README (a Read tool call
// on docs/plans/) and its final answer names docs/plans. The Read is the
// behavioral signal; the answer text alone would be word-checking.
import { readFileSync } from "node:fs";
const lines = readFileSync(process.env.EVAL_TRANSCRIPT, "utf8").split("\n").filter(Boolean);
let readPlanDocs = false;
let finalText = "";
for (const line of lines) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event?.type === "result" && typeof event.result === "string") finalText = event.result;
  const blocks = event?.message?.content;
  if (!Array.isArray(blocks)) continue;
  for (const block of blocks) {
    if (block?.type === "tool_use" && (block.name === "Read" || block.name === "Glob" || block.name === "Grep")) {
      const target = String(block.input?.file_path ?? block.input?.path ?? block.input?.pattern ?? "");
      if (/docs\/plans|LOOP\.md|AGENTS\.md|CLAUDE\.md/u.test(target)) readPlanDocs = true;
    }
  }
}
const namesPlan = /docs\/plans/u.test(finalText) && /proof/iu.test(finalText);
console.log(`read plan docs: ${readPlanDocs}; answer names docs/plans and Proof: ${namesPlan}`);
process.exitCode = readPlanDocs && namesPlan ? 0 : 1;
