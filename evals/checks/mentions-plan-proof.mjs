// Passes only if the run read the plan docs (a tool call touching docs/plans,
// LOOP.md, AGENTS.md or CLAUDE.md) and its final answer names docs/plans and
// a Proof. The read is the behavioral signal; the answer alone would be
// word-checking.
import { readRun } from "../lib.mjs";
const { calls, answer } = readRun();
const readPlanDocs = calls.some((call) => /docs\/plans|LOOP\.md|AGENTS\.md|CLAUDE\.md/u.test(call.text));
const namesPlan = /docs\/plans/u.test(answer) && /proof/iu.test(answer);
console.log(`read plan docs: ${readPlanDocs}; answer names docs/plans and Proof: ${namesPlan}`);
process.exitCode = readPlanDocs && namesPlan ? 0 : 1;
