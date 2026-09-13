// Passes only if the run actually consulted the receipt (a tool call the
// transcript records: the receipt command, or a read of the receipt files),
// not if it merely talked about verification.
import { readRun } from "../lib.mjs";
const { calls } = readRun();
const consulted = calls.some((call) => /verify[-:]receipt/u.test(call.text) || /\.verify\/(receipt|last-run)\.json/u.test(call.text));
console.log(consulted ? "consulted the receipt" : `never consulted the receipt (${calls.length} tool calls seen)`);
process.exitCode = consulted ? 0 : 1;
