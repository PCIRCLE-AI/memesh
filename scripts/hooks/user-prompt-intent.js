#!/usr/bin/env node

// User Prompt Intent — UserPromptSubmit hook
//
// Detects when the user explicitly asks Claude to remember / save / memorize
// content from the current session, and injects a context hint reminding Claude
// to use `mcp__memesh__remember` for cross-project recall.
//
// Why a hint instead of autonomous capture? The user's intent is clear, but
// "what to remember" usually depends on the surrounding conversation —
// extracting that requires an LLM round and policy decisions (name, type,
// observations, namespace). A polite reminder keeps the calling agent in the
// loop with full conversation context, while still preventing the
// "I forgot to use memesh" failure mode that motivated this hook.
//
// Defensive: never blocks user prompts, even on hook failure. Errors are
// surfaced to stderr (visible in Claude Code debug logs) rather than
// swallowed — stderr does not affect prompt submission.
// Gated by `autoCapture` flag (same as other memesh write hooks).

import { pathToFileURL } from 'url';
import {
  findAutoUpdateConsent,
  importFromPluginRoot,
  isAutoCaptureEnabled,
  hookErrorReason,
  recordHookOutcome,
  markUpdatePromptAnswered,
  memeshDir,
  parseAutoUpdateConsent,
  readUpdateCheckCache,
  readUpdatePromptClaim,
  resolvePluginRoot,
  writeAutoUpdateConsent,
  writeSnooze,
} from './_shared.js';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

let installChannelMod = null;
try {
  const pluginRoot = resolvePluginRoot(import.meta.url);
  const modulePath = join(pluginRoot, 'dist/core/install-channel.js');
  if (existsSync(modulePath)) installChannelMod = await import(pathToFileURL(modulePath).href);
} catch {
  // Source checkouts without a build remain non-blocking and cannot self-update.
}

function currentInstallChannel() {
  try {
    return installChannelMod?.getCurrentInstallChannel({
      packageRoot: resolvePluginRoot(import.meta.url),
    }) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function currentInstalledVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(resolvePluginRoot(import.meta.url), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
}

/**
 * Record the owner's answer to this session's first-use update notice.
 *
 * Returns 'approved' | 'declined' | 'never' | null. The answer counts only
 * when THIS session was actually shown the notice (a prompt claim exists for
 * session/current/latest), so a stray "no" in unrelated conversation is not
 * a decision about updates.
 *
 *   approved — npm-global only (the one channel with a hook-owned installer);
 *              other channels were told their manual action and cannot be
 *              approved into an install.
 *   declined — "Not now": escalating snooze for this target version, on
 *              every channel. A distinct newer target is offered again.
 *   never    — "Never ask again": config.updateCheck = false; also snoozed so
 *              a host that already read the old config stays quiet.
 */
async function recordUpdateConsent(sessionId, prompt) {
  const current = currentInstalledVersion();
  if (!current || !sessionId) return null;
  const cache = readUpdateCheckCache(current);
  const latest = cache?.latestVersion;
  if (typeof latest !== 'string' || !latest) return null;
  const decision = parseAutoUpdateConsent(prompt);
  if (!decision) return null;
  const channel = currentInstallChannel();
  const pending = channel === 'npm-global'
    ? findAutoUpdateConsent(sessionId, current, latest, channel)
    : null;
  const claim = readUpdatePromptClaim(sessionId, current, latest);
  // The notice must have been shown to THIS session and not answered yet.
  // Once answered, later "no"/"later" in ordinary conversation is not a
  // decision about updates (it used to escalate the snooze every time).
  const open = (claim && claim.decision !== 'answered') || pending?.decision === 'pending';
  if (!open) return null;

  if (decision === 'approved') {
    if (!pending || pending.decision !== 'pending') return null;
    if (!writeAutoUpdateConsent(sessionId, current, latest, pending.channel ?? channel, 'approved')) return null;
    markUpdatePromptAnswered(sessionId, current, latest, 'approved');
    return 'approved';
  }
  // declined | never
  try { writeSnooze(memeshDir(), latest); } catch { /* best-effort */ }
  if (pending?.decision === 'pending') {
    writeAutoUpdateConsent(sessionId, current, latest, pending.channel ?? channel, 'declined');
  }
  let recorded = decision;
  if (decision === 'never') {
    try {
      const configMod = await importFromPluginRoot(resolvePluginRoot(import.meta.url), 'dist/core/config.js');
      configMod.updateConfig({ updateCheck: false });
    } catch (err) {
      logError('user-prompt-intent', `could not persist updateCheck=false: ${err?.message || err}`);
      recorded = 'declined';
    }
  }
  markUpdatePromptAnswered(sessionId, current, latest, recorded);
  return recorded;
}

// Patterns compiled at module load — invalid regex MUST fail loudly. Do
// NOT move into a try block "for safety": a regex compile error is a
// programmer error, not a runtime condition, and silencing it would hide
// real bugs.
//
// Design principle: when in doubt between matching and not matching, do
// NOT match — a missed hint is recoverable (user repeats themselves), but
// a false hint pollutes context and pressures the LLM into a wrong action.
//
// Disambiguation policy:
//   - All imperatives anchored to sentence start (^ or after .!?\n) to skip
//     interrogatives ("do you remember X?", "What does save to memesh do?").
//   - For save-class verbs, "memesh" suffix required to avoid false positives
//     on generic "save this" (could mean clipboard, file, bookmark, etc.).
//   - Supported languages: English, Spanish, French, Portuguese, Traditional Chinese.
//     Additional languages welcome via PR (provide native-speaker validation).
export const INTENT_PATTERNS = [
  // English: "Remember/memorize this|that"
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:remember|memorize)\s+(?:this|that)\b/im,
  // English: "save/add/store to memesh"
  /(?:^|[.!?\n]\s*)(?:please\s+)?(?:save|add|put|store|write)\s+(?:(?:this|that|it)\s+)?(?:to|in|into)\s+memesh\b/im,

  // Spanish: "Recordar/memorizar esto|eso"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:recordar|memorizar)\s+(?:esto|eso)\b/im,
  // Spanish: "guardar en memesh"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:guardar|añadir|almacenar)\s+(?:(?:esto|eso)\s+)?(?:en|a)\s+memesh\b/im,

  // French: "Rappeler/mémoriser ceci|cela"
  /(?:^|[.!?\n]\s*)(?:s'il vous plaît\s+)?(?:rappeler|mémoriser)\s+(?:ceci|cela|ça)\b/im,
  // French: "sauvegarder dans memesh"
  /(?:^|[.!?\n]\s*)(?:s'il vous plaît\s+)?(?:sauvegarder|enregistrer|ajouter)\s+(?:(?:ceci|cela|ça)\s+)?(?:dans|à)\s+memesh\b/im,

  // Portuguese: "Lembrar/memorizar isto|isso"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:lembrar|memorizar)\s+(?:isto|isso)\b/im,
  // Portuguese: "salvar em memesh"
  /(?:^|[.!?\n]\s*)(?:por favor\s+)?(?:salvar|guardar|adicionar|armazenar)\s+(?:(?:isto|isso)\s+)?(?:em|no)\s+memesh\b/im,

  // Traditional Chinese: 記下來, 記到/存到/寫進/存進 memesh|記憶
  /記下來|記到\s*(?:memesh|記憶)|存到\s*(?:memesh|記憶)|寫進\s*(?:memesh|記憶)|存進\s*(?:memesh|記憶)/,
];

export function detectRememberIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  for (const re of INTENT_PATTERNS) {
    if (re.test(prompt)) return true;
  }
  return false;
}

// The returned string is consumed BY THE LLM as additionalContext, NOT by
// configuration or by Claude Code itself. Edits here change LLM behavior,
// not hook behavior.
export function buildHint() {
  return [
    '<memesh-remember-intent>',
    'The user just asked you to save / remember content. Use memesh for cross-project recall:',
    '',
    '1. Decide WHAT to remember from the conversation context. Be specific — pick observations',
    '   that will be useful in *future* sessions, not session-local state.',
    '',
    '2. Decide the SCOPE for a NEW memory (this drives namespace + tags):',
    '   • Machine-level / cross-project / preferences  → memesh namespace=personal',
    '   • Project-internal decision / pattern / lesson → memesh + project tag (e.g. tag:project:memesh)',
    '   • Universal / public best practice             → memesh namespace=global (rare)',
    '',
    '3. Call `mcp__memesh__remember` with:',
    '   • name: descriptive entity name (e.g., "aws-cdk-stack-pattern")',
    '   • type: one of (decision, pattern, lesson_learned, bug, process, preference, etc.)',
    '   • observations: array of specific facts / steps / rationale',
    '   • tags: relevant tags (programming language, framework, domain)',
    '   • namespace: personal | team | global — OMIT for a memory that already exists.',
    '     Supplying it MOVES that memory out of the scope it is in.',
    '',
    '4. Confirm to the user with: entity name + memesh ID returned by the tool.',
    '</memesh-remember-intent>',
  ].join('\n');
}

function logError(scope, msg) {
  // Hooks may write to stderr without blocking prompt submission. Use this
  // to surface failures in Claude Code debug logs instead of swallowing.
  try {
    process.stderr.write(`[memesh:${scope}] ${msg}\n`);
  } catch {
    // stderr itself failing is unrecoverable; stay silent.
  }
}

// Only run the stdin pipeline when invoked directly as a script — not when
// imported by the test suite for in-process unit testing. On Windows,
// `file://${process.argv[1]}` produces an invalid URL because the path uses
// backslashes; pathToFileURL() correctly normalizes to a file:// URL on
// every platform, so the comparison is portable.
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  // See post-commit.js for why every exit path leaves a record (#327). This
  // hook's "wrote" is the additionalContext it injected — the only durable
  // effect it has.
  let payload = null;
  const record = (outcome, reason, entity) =>
    recordHookOutcome(process.env, { hook: 'user-prompt-intent', outcome, reason, entity, payload });

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      // Distinguish empty stdin (legitimate degenerate event) from malformed
      // input (protocol drift). Both stay non-blocking, but only malformed
      // input is logged — empty is normal, garbage indicates a real bug.
      let data = {};
      const trimmed = input.trim();
      if (trimmed) {
        try {
          data = JSON.parse(trimmed);
        } catch (parseErr) {
          logError('user-prompt-intent', `malformed stdin JSON (len=${input.length}): ${parseErr.message}`);
          record('error', 'malformed stdin JSON');
          return process.exit(0);
        }
      }

      // Claude Code sends `prompt`. The `user_prompt` fallback is defensive:
      // Claude Code's transcript format changed once before (2026-05-07), so
      // we accept either name to survive a similar rename. If both are absent
      // or non-string, detectRememberIntent's type guard returns false safely.
      payload = data;
      const prompt = data.prompt ?? data.user_prompt ?? '';
      const updateDecision = await recordUpdateConsent(data.session_id, prompt);
      const rememberIntent = detectRememberIntent(prompt);
      if (!rememberIntent && !updateDecision) {
        record('skipped', 'the prompt carried no remember intent and no update decision');
        return process.exit(0);
      }
      // Update consent is a user-authorized control decision, not memory
      // capture; it must still be recorded when auto-capture is disabled.
      if (!isAutoCaptureEnabled(process.env) && !updateDecision) {
        record('skipped', 'auto-capture is turned off');
        return process.exit(0);
      }

      const contexts = [];
      if (updateDecision === 'approved') {
        contexts.push('The user explicitly approved the MeMesh upgrade. The Stop hook may now update the consented installation.');
      } else if (updateDecision === 'declined') {
        contexts.push('The user declined the MeMesh upgrade. It is snoozed for this target version (24h, then 48h, then 7 days on repeated declines); do not install it or mention it again unless a newer version appears.');
      } else if (updateDecision === 'never') {
        contexts.push('The user asked never to be asked about MeMesh updates again. updateCheck is now off; do not mention updates. `memesh config set updateCheck true` turns checks back on.');
      }
      if (rememberIntent) contexts.push(buildHint());
      const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: contexts.join('\n\n') } };
      process.stdout.write(JSON.stringify(out));
      record('wrote', undefined, `hint:${updateDecision ?? 'remember-intent'}`);
      process.exit(0);
    } catch (err) {
      logError('user-prompt-intent', err?.message || err);
      record('error', hookErrorReason(err));
      process.exit(0);
    }
  });
}
