// What a check reads: the transcript of one eval run, normalized to tool calls
// and the final answer regardless of which CLI produced it. EVAL_TRANSCRIPT
// and EVAL_PROVIDER are set by evals/run.mjs.
import { readFileSync } from "node:fs";
import { finalText, toolCalls } from "../scripts/sdlc/agent.mjs";

export function readRun(env = process.env) {
  const provider = env.EVAL_PROVIDER ?? "claude";
  const transcript = readFileSync(env.EVAL_TRANSCRIPT, "utf8");
  return { provider, calls: toolCalls(provider, transcript), answer: finalText(provider, transcript) };
}
