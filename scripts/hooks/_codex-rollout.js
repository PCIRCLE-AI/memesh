// Reads Codex rollout rows into the same facts parseTranscript collects from a
// Claude transcript: tool-call count, edited files, commands, errors.
//
// Codex records what happened twice:
//   - `event_msg` / `item_completed` rows with a structured result:
//     `CommandExecution` (command, status, exit_code, aggregated_output) and
//     `FileChange` (changes by path, status). These are the source of truth.
//   - `response_item` rows: a `custom_tool_call` named `exec` whose input is JS
//     calling `tools.apply_patch` / `tools.exec_command`, and its output rows.
//     They give the tool-call count, the "Script failed" header, and the
//     results a script printed.
// Edits are inferred from the JS text and printed output only when a rollout
// holds no structured row at all (an older Codex), and then only on positive
// evidence: an unknown result is never counted as success.
//
// Failures come from the structured rows. A command that never started leaves
// no row, but its failure may be printed by a script, so a printed failure is
// reported too unless a failed command row accounts for it. Each failed command
// row accounts for one printed failure with the same exit code and
//   - the same output anywhere in the rollout (equal, or one contained in the
//     other), or
//   - in the same result window: the same first or last 80 characters, the same
//     command, or both outputs empty, or
//   - the process the script polled with `write_stdin({ session_id })`, which the
//     row names as its process_id.
// A failure printed again later counts once. The rows carry no id tying a
// command to the script that printed it, so this is a best-effort match, not
// exact: it can still miss a failure or report a repeat.

import { bashEditedFileNames, editedFileName, isScratchPath } from './_generated/bash-edited-paths.js';
import { isCodexToolRequest } from './_generated/host-transcript.js';

const PATCH_HEADER = /\*\*\* (?:Add|Update) File: ([^\n\\"'`]+)/g;
const CMD_LITERAL = /\bcmd["']?\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
// session-summary stores the text of the first three errors. Each list below
// (recorded, printed-only, script) keeps this many in full and redacted, so up
// to three times as many are held; the rest are counted.
const ERROR_TEXTS_KEPT = 3;
// Marks a JSON object as a tool result rather than a document that happens to
// contain an `exit_code` field (a printed package.json, a fixture).
const RESULT_MARKERS = ['wall_time_seconds', 'chunk_id', 'original_token_count'];
// How many recent failed command rows and printed failures a match looks back over.
const LOOKBACK = 500;
// Output kept per failed command row for matching.
const SNAPSHOT_HEAD = 3000;
const SNAPSHOT_TAIL = 1000;

export function createCodexState() {
  return {
    sawStructured: false,
    structured: { files: new Set(), commands: [], errors: newErrors() },
    fallback: { files: new Set(), commands: [], failures: newErrors() },
    unmatched: newErrors(),
    scriptErrors: newErrors(),
    pending: new Map(),
    // Failed command rows, and the failures scripts printed, with the result
    // window (one per result row seen) each belongs to.
    ces: [],
    printedSeen: [],
    unmatchedPrinted: [],
    window: 0,
    windowFailures: 0,
  };
}

function newErrors() {
  return { items: [], omitted: 0 };
}

// An error to report. `text` is kept only for the first few; `note` stands in
// for the rest and when there is no text.
function addError(list, text, note) {
  if (list.items.length >= ERROR_TEXTS_KEPT) {
    list.omitted++;
    return null;
  }
  const entry = { text: typeof text === 'string' && text ? text : null, note };
  list.items.push(entry);
  return entry;
}

// Redact the whole text and only then cut, as the Claude path does: a cut first
// can split a secret in two and leave a fragment the redaction no longer matches.
function finalText(entry, redact) {
  return redact(entry.text ?? entry.note).slice(0, 200);
}

function finishErrors(list, sink, redact) {
  for (const entry of list.items) sink.errorsEncountered.push(finalText(entry, redact));
  for (let i = 0; i < list.omitted; i++) sink.errorsEncountered.push('error');
}

function decodeLiteral(lit) {
  try {
    return JSON.parse(lit[0] === '"' ? lit : JSON.stringify(lit.slice(1, -1)));
  } catch {
    return null;
  }
}

function outputTexts(output) {
  if (typeof output === 'string') return [output];
  if (!Array.isArray(output)) return [];
  return output.map(item => (typeof item?.text === 'string' ? item.text : '')).filter(Boolean);
}

function noteCommand(cmd, into, redact) {
  if (cmd.length > 10 && !cmd.startsWith('ls') && !cmd.startsWith('cd')) {
    into.push(redact(cmd).slice(0, 100));
  }
}

// Exit codes of the tool results a script printed. Text that is not a JSON tool
// result has none: `"exit_code": 3` inside a printed file is content.
function printedResults(text) {
  const found = [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return found; }
  const stack = [parsed];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    }
    else if (node && typeof node === 'object') {
      if (Number.isInteger(node.exit_code) && typeof node.output === 'string' && RESULT_MARKERS.some(k => k in node)) {
        found.push({
          code: node.exit_code,
          output: typeof node.output === 'string' ? node.output : '',
          cmd: typeof node.cmd === 'string' ? node.cmd : '',
        });
      }
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return found;
}

// Output kept for matching: trimmed, and bounded for a very long one.
function snapshot(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t.length <= SNAPSHOT_HEAD + SNAPSHOT_TAIL ? t : `${t.slice(0, SNAPSHOT_HEAD)}\n${t.slice(-SNAPSHOT_TAIL)}`;
}

// Is a printed output a copy of another: equal, or one contained in the other
// (a shortened or trimmed print)?
function sameCopy(x, y) {
  return x === y || (x !== '' && y !== '' && (x.includes(y) || y.includes(x)));
}

// A weaker test, trusted only close in time: the same first or last 80
// characters. Different failures often open alike (a shared error header), so
// across result windows it would absorb a failure that is really a new one.
function sameEdges(x, y) {
  if (!x || !y) return false;
  const n = Math.min(80, x.length, y.length);
  return x.slice(0, n) === y.slice(0, n) || x.slice(-n) === y.slice(-n);
}

function sameCode(a, b) {
  return a === null || b === null || a === b;
}

function lastMatch(list, test) {
  for (let i = list.length - 1, seen = 0; i >= 0 && seen < LOOKBACK; i--, seen++) {
    if (test(list[i])) return i;
  }
  return -1;
}

function readStructured(item, state, redact) {
  const out = state.structured;
  if (item.type === 'CommandExecution') {
    state.sawStructured = true;
    const cmd = Array.isArray(item.command) ? item.command[item.command.length - 1] : item.command;
    if (typeof cmd === 'string') noteCommand(cmd, out.commands, redact);
    if (item.status === 'completed' && item.exit_code === 0) {
      if (typeof cmd === 'string') for (const f of bashEditedFileNames(cmd)) out.files.add(f);
      return;
    }
    const code = Number.isInteger(item.exit_code) ? item.exit_code : null;
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
    addError(out.errors, output, code === null ? 'command failed' : `command exited with code ${code}`);
    const row = {
      code, output: snapshot(output), cmd: typeof cmd === 'string' ? cmd : '',
      pid: typeof item.process_id === 'string' ? item.process_id : '', window: state.window, claimed: false,
    };
    // A script that already printed this failure before the row was logged:
    // the row accounts for it, so it was not a missing one.
    const at = lastMatch(state.unmatchedPrinted, p => sameCode(p.code, code)
      && ((p.output !== '' && (sameCopy(p.output, row.output) || (p.window >= state.window - 1 && sameEdges(p.output, row.output))))
        || (row.pid !== '' && p.sessions.has(row.pid))));
    if (at >= 0) {
      const [printed] = state.unmatchedPrinted.splice(at, 1);
      printed.forget();
      row.claimed = true;
    }
    state.ces.push(row);
    state.windowFailures++;
  } else if (item.type === 'FileChange') {
    state.sawStructured = true;
    if (item.status === 'completed') {
      for (const [path, change] of Object.entries(item.changes ?? {})) {
        if (change?.type !== 'add' && change?.type !== 'update') continue;
        const target = change.move_path || path;
        const name = isScratchPath(target) ? null : editedFileName(target);
        if (name) out.files.add(name);
      }
    } else {
      addError(out.errors, item.stderr, 'file change failed');
    }
  }
}

function readCall(item, state, redact) {
  if (item.type === 'function_call') return;
  const code = item.name === 'exec' && typeof item.input === 'string' ? item.input : '';
  const patchFiles = [];
  const bashFiles = [];
  const commands = [];
  const cmds = new Set();
  for (const m of code.matchAll(PATCH_HEADER)) {
    const target = m[1].trim();
    const name = isScratchPath(target) ? null : editedFileName(target);
    if (name) patchFiles.push(name);
  }
  for (const m of code.matchAll(CMD_LITERAL)) {
    const cmd = decodeLiteral(m[1]);
    if (typeof cmd !== 'string') continue;
    cmds.add(cmd);
    bashFiles.push(...bashEditedFileNames(cmd));
    noteCommand(cmd, commands, redact);
  }
  // `write_stdin({ session_id: N })` polls a command that is still running; the
  // command's row names that same number as its process_id.
  const sessions = new Set();
  for (const call of code.matchAll(/\bwrite_stdin\(\s*\{([^}]*)\}/g)) {
    for (const m of call[1].matchAll(/\bsession_id["']?\s*:\s*(\d+)/g)) sessions.add(m[1]);
  }
  if (typeof item.call_id === 'string') state.pending.set(item.call_id, { patchFiles, bashFiles, commands, cmds, sessions });
}

// One printed failure: is it a repeat, is it one a failed command row already
// recorded, or is it a failure no row accounts for?
function settlePrinted(r, call, state) {
  const output = snapshot(r.output);
  if (lastMatch(state.printedSeen, p => p.code === r.code && sameCopy(p.output, output)) >= 0) return;
  state.printedSeen.push({ code: r.code, output });
  addError(state.fallback.failures, r.output, `command exited with code ${r.code}`);

  // A failed row accounts for one printed failure when it has the same output
  // (or, within this result window, the same start or end, or the same command),
  // or when this script polled the very process the row ran. An empty output
  // says nothing, so it only matches inside the window.
  const polled = row => row.pid !== '' && (call?.sessions.has(row.pid) ?? false);
  const near = row => row.window === state.window;
  const fits = row => sameCode(row.code, r.code) && (
    polled(row)
    || (output !== '' && sameCopy(row.output, output))
    || (near(row) && ((output === '' && row.output === '') || sameEdges(row.output, output) || row.cmd === r.cmd || (call?.cmds.has(row.cmd) ?? false))));
  const free = lastMatch(state.ces, row => !row.claimed && fits(row));
  if (free >= 0) {
    state.ces[free].claimed = true;
    return;
  }
  // Already claimed by an earlier print of the same failure.
  // Only the same text counts as a repeat: another failure in a polling script
  // is a new one.
  const sameText = row => (output !== '' && sameCopy(row.output, output)) || (output === '' && row.output === '');
  if (lastMatch(state.ces, row => row.claimed && sameCode(row.code, r.code) && (polled(row) ? (sameText(row) || output === '') : sameText(row))) >= 0) return;
  const entry = addError(state.unmatched, r.output, `command exited with code ${r.code}`);
  state.unmatchedPrinted.push({
    code: r.code,
    output,
    window: state.window,
    sessions: call?.sessions ?? new Set(),
    forget: () => {
      const at = entry ? state.unmatched.items.indexOf(entry) : -1;
      if (at >= 0) state.unmatched.items.splice(at, 1);
      else if (!entry) state.unmatched.omitted--;
    },
  });
  if (state.unmatchedPrinted.length > LOOKBACK) state.unmatchedPrinted.shift();
}

function readOutput(item, state) {
  const texts = outputTexts(item.output);
  const scriptFailed = texts[0]?.startsWith('Script failed') === true;
  const call = state.pending.get(item.call_id);
  if (call) state.pending.delete(item.call_id);
  const results = texts.flatMap(printedResults);
  const failures = results.filter(r => r.code !== 0);
  for (const r of failures) settlePrinted(r, call, state);
  // A script that threw after a failed command already has that failure.
  if (scriptFailed && failures.length === 0 && state.windowFailures === 0) {
    addError(state.scriptErrors, texts.slice(1).join(' '), texts[0]);
  }
  state.window++;
  state.windowFailures = 0;

  if (!call) return;
  const fb = state.fallback;
  fb.commands.push(...call.commands);
  // Only a script that ran to completion can have applied anything: a result
  // that is aborted, still running or unknown is not success. A shell edit also
  // needs a printed result that reports exit 0, and none that fails.
  if (texts[0]?.startsWith('Script completed') !== true) return;
  for (const f of call.patchFiles) fb.files.add(f);
  if (results.length > 0 && results.every(r => r.code === 0)) for (const f of call.bashFiles) fb.files.add(f);
}

// Feeds one parsed JSONL row. Returns 1 when the row is a tool request, else 0.
export function readCodexRow(entry, state, redact) {
  const item = entry?.payload;
  if (entry?.type === 'event_msg' && item?.type === 'item_completed' && item.item) {
    readStructured(item.item, state, redact);
    return 0;
  }
  if (entry?.type !== 'response_item') return 0;
  if (isCodexToolRequest(entry)) {
    readCall(item, state, redact);
    return 1;
  }
  if (item?.type === 'custom_tool_call_output' || item?.type === 'function_call_output') readOutput(item, state);
  return 0;
}

// Merges what the rollout held into the parseTranscript collections.
export function finishCodex(state, sink, redact) {
  const { structured, fallback } = state;
  const src = state.sawStructured ? structured : fallback;
  for (const f of src.files) sink.filesEdited.add(f);
  sink.bashCommands.push(...src.commands);
  if (state.sawStructured) {
    finishErrors(structured.errors, sink, redact);
    finishErrors(state.unmatched, sink, redact);
  } else {
    finishErrors(fallback.failures, sink, redact);
  }
  finishErrors(state.scriptErrors, sink, redact);
}
