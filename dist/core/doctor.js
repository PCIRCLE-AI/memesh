import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { findRetiredConfigKeys, getConfigPath, readConfig } from './config.js';
import { openDatabase, closeDatabase, isDatabaseOpen, readOnlyFolderState, } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { classifyBump } from './updater.js';
import { AUTO_UPDATE_REASONS, currentPolicy, describeLockHolder, inspectAutoUpdateState, readInstalling } from './auto-update.js';
import { getCurrentInstallChannel, getInstallChannelSupport, detectPluginHost, pluginHostConfigRoot, versionedPluginCacheRoots, PLUGIN_REFRESH_COMMANDS, } from './install-channel.js';
import { readInstallRecordState } from './install-id.js';
import { isWritable, ownerWriteCommand, runOrSay, shellQuote } from './file-mode.js';
import { unreadDeliveryCount } from './agent-message-inbox.js';
import { damagedDatabaseFix, diagnoseDatabaseFailure, isDamagedDatabaseError } from './database-diagnosis.js';
import { withoutFinalPeriod } from './sentence.js';
import { AutoArchiveRecordUnreadable, readLastAutoArchiveRun } from './lifecycle.js';
import { citationRulePath, citationRuleState } from './citation-rule.js';
import { getAgentRouterSocketPath, getDbPath, getMemeshDirFromDbPath, homeDir, memeshDir } from './paths.js';
import { findProjectIdentitySplits } from './project-identity-split.js';
import { AGENT_ROUTER_SOCKET_PATH_MAX_BYTES } from './agent-router.js';
import { detectPluginRuntime, readInstallMarker } from './install-hooks.js';
import { manifestScope } from './manifest-scope.js';
import { claudeCodePresent, codexPresent, geminiPresent, isOnPath } from './host-presence.js';
import { UNSPACED_SCRIPT_GLOB_RUN3 } from '../storage/fts-index.js';
import { isUnsupportedNode, MemeshDatabase, MIN_NODE_SERIES } from '../storage/sqlite.js';
import { AUTO_CAPTURE_TAG } from './types.js';
import { SESSION_HANDOFF_TYPE } from './session-handoff.js';
import { parseSqliteUtcMs, sqliteUtcToIso } from './time-utils.js';
import { autoCaptureDecision } from './capture-flag.js';
import { summarizeNoteHolds } from './note-ingest.js';
import { decidePrivacy } from './private-session.js';
import { captureLivenessVerdict, parseHookOutcomes, summarizeHookOutcomes, summarizeTypeTrends, FAIL_ELIGIBLE_HOOKS, SKIP_REASONS, HOOK_OUTCOMES_FILENAME, NEVER_RAN_GRACE_HOURS, SILENT_HOOK_MIN_RUNS, RECENT_ERROR_RUNS, } from './capture-liveness.js';
import { guardFromMetadata } from './guards.js';
import { getAgentMessageStorageReport } from './agent-message-storage.js';
import { HANDLED_RECEIPT_KINDS_SQL } from './agent-messaging.js';
import { AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES, AGENT_MESSAGE_EXPIRY_INTERVAL_MS, databaseFile, inspectAgentMessageArchive, lastAgentMessageExpiryRun, latestAgentMessageExpiryArchive, } from './agent-message-expiry.js';
import { readHostConfigFile } from '../host-runtime/config.js';
import { journeyRecordPath, readJourneyRecord } from './doctor-journey.js';
import { readRouterIdleExit } from '../host-runtime/router-idle.js';
const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];
const AGENT_MESSAGE_STORAGE_QUOTA_ENV = 'MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES';
const LOCALE_README_FILES = [
    'README.zh-TW.md',
];
const LOCALE_H2_TOLERANCE = 1;
function countH2Headings(content) {
    let n = 0;
    let inFence = false;
    for (const line of content.split('\n')) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        if (line.startsWith('## '))
            n++;
    }
    return n;
}
function inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl) {
    const englishPath = path.join(packageRoot, 'README.md');
    if (!existsSyncImpl(englishPath)) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', 'README.md not present in this install; locale-parity check skipped.');
    }
    let englishCount;
    try {
        englishCount = countH2Headings(readFileSyncImpl(englishPath, 'utf8'));
    }
    catch (err) {
        return createCheck('readme_locale_parity', 'README locale parity', 'warn', `Could not read README.md: ${err instanceof Error ? err.message : String(err)}`, undefined, { code: 'readme-parity.unreadable', params: { detail: err instanceof Error ? err.message : String(err) } });
    }
    const present = LOCALE_README_FILES.filter((filename) => existsSyncImpl(path.join(packageRoot, filename)));
    if (present.length === 0) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', 'No locale README in this install; locale-parity check skipped.');
    }
    const drift = [];
    for (const filename of present) {
        try {
            const count = countH2Headings(readFileSyncImpl(path.join(packageRoot, filename), 'utf8'));
            if (Math.abs(count - englishCount) > LOCALE_H2_TOLERANCE) {
                drift.push({ name: filename, count });
            }
        }
        catch {
            drift.push({ name: filename, count: -1 });
        }
    }
    if (drift.length === 0) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', `${present.join(', ')} match the English H2 count (${englishCount}).`);
    }
    const driftDetail = drift
        .map((d) => `${d.name}=${d.count === -1 ? 'unreadable' : d.count}`)
        .join(', ');
    const detail = `H2 count drift (English=${englishCount}): ${driftDetail}`;
    return createCheck('readme_locale_parity', 'README locale parity', 'warn', detail, `Re-sync the listed READMEs against README.md so section structure matches (±${LOCALE_H2_TOLERANCE} H2 tolerated to absorb translation collapse).`, { code: 'readme-parity.drift', params: { detail, tolerance: LOCALE_H2_TOLERANCE } });
}
function resolveDatabasePath() {
    return getDbPath();
}
const NODE_TOO_OLD_FIX = `Upgrade Node to ${MIN_NODE_SERIES} or newer, then run \`memesh doctor\` again.`;
const NODE_TOO_OLD_SEE_DATABASE_ROW = 'Not checked: this Node cannot open the MeMesh database (the Database row above says why).';
function queryFailedSummary(err, detail, what, unknownMeans) {
    if (isUnsupportedNode(err))
        return NODE_TOO_OLD_SEE_DATABASE_ROW;
    return `Could not read ${what} from the database: ${withoutFinalPeriod(detail)}. ${unknownMeans}`;
}
export class NoDatabaseYetError extends Error {
    databasePath;
    constructor(databasePath) {
        super(`No database at ${databasePath} yet`);
        this.databasePath = databasePath;
        this.name = 'NoDatabaseYetError';
    }
}
function openDatabaseForDoctor(dbPath, opts = {}) {
    const target = dbPath ?? getDbPath();
    if (!fs.existsSync(target))
        throw new NoDatabaseYetError(target);
    return openDatabase(target, { ...opts, readOnly: true });
}
function isSchemaBehind(err) {
    if (typeof err?.fix === 'string')
        return false;
    return /no such (table|column)/i.test(err instanceof Error ? err.message : String(err));
}
function schemaBehindNote(databasePath = getDbPath()) {
    const base = 'The database was written by an older version and has not been brought up to date yet. Doctor opens it read-only and does not migrate it';
    const update = 'run any memesh command (for example `memesh recall x`) to update it, then run doctor again.';
    const folder = readOnlyFolderState();
    if (folder)
        return `${base}, and ${folder.reason}, so a memesh command could not update it either. First ${runOrSay(folder.fix).replace(/^Run: /, 'run: ')}; then ${update}`;
    let writeBack;
    try {
        writeBack = ownerWriteCommand(databasePath);
    }
    catch {
        writeBack = undefined;
    }
    if (writeBack)
        return `${base}, and the database file is read-only, so a memesh command could not update it either. First ${writeBack}; then ${update}`;
    return `${base}: ${update}`;
}
function queryFailedFix(err) {
    if (isUnsupportedNode(err))
        return NODE_TOO_OLD_FIX;
    const fix = err?.fix;
    if (typeof fix === 'string') {
        return `MeMesh did not open the database because of its permissions; the Database row above explains why. ${runOrSay(fix)}`;
    }
    const detail = err instanceof Error ? err.message : String(err);
    if (/readonly database|SQLITE_READONLY/i.test(detail)) {
        return 'The database is read-only; the Database row above shows the command that makes it writable again.';
    }
    if (/database is locked|SQLITE_BUSY/i.test(detail)) {
        return 'Another process has the database locked; wait for it to finish, or stop it, then retry.';
    }
    return 'The error is quoted above. Check that ~/.memesh is readable and that the disk is not full.';
}
function quickIntegrityVerdict(db) {
    let row;
    try {
        row = db.prepare('PRAGMA quick_check(1)').get();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isDamagedDatabaseError(message))
            throw err;
        return message.replace(/\s+/g, ' ').slice(0, 200);
    }
    if (typeof row?.quick_check !== 'string')
        return 'quick_check returned no verdict';
    return row.quick_check.replace(/\s+/g, ' ').slice(0, 200);
}
function knownTranscriptPath(file) {
    if (typeof file !== 'string' || file === '')
        return undefined;
    let real;
    try {
        real = fs.realpathSync(file);
    }
    catch {
        return file;
    }
    const roots = [
        path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude'), 'projects'),
        ...['sessions', 'archived_sessions'].map((d) => path.join(process.env.CODEX_HOME || path.join(homeDir(), '.codex'), d)),
    ];
    for (const root of roots) {
        let realRoot;
        try {
            realRoot = fs.realpathSync(root);
        }
        catch {
            continue;
        }
        if (real.startsWith(realRoot + path.sep))
            return real;
    }
    return undefined;
}
const HERMES_MARKER_FIX = 'Hermes could not keep or read its private-session marker. Check that the memesh-private-sessions folder in the Hermes home is a folder you can read and write, and that Hermes was started with a home folder. This row clears once five later Hermes captures have checked the marker without an error.';
const PRIVATE_FOLDER_FIX = 'The private-sessions folder beside the database cannot be read, so every session is treated as private and nothing is saved. Make it a folder you can read and write again (for example `chmod u+rwx` on it); do not delete it: it is the record of the sessions that asked not to be remembered. This row clears once the hook\'s most recent runs end without an error.';
const PRIVATE_STATE_ERROR_FIXES = Object.freeze({
    [SKIP_REASONS.privateCheckMarkerUnreadable]: PRIVATE_FOLDER_FIX,
    [SKIP_REASONS.noteMarkersDirUnreadable]: PRIVATE_FOLDER_FIX,
});
const DOCTOR_PRIVACY_CHECK_MS = 2000;
const DOCTOR_PRIVACY_TOTAL_MS = 10_000;
export function inspectPrivateNoteHolds(now = Date.now()) {
    const summary = summarizeNoteHolds(now);
    if (summary.unsettled.length === 0 && summary.damaged.length === 0 && summary.waitingOnUnreadable.length === 0 && summary.unreadableFolders.length === 0)
        return null;
    const lines = [];
    const fixes = [];
    for (const f of summary.unreadableFolders) {
        lines.push(`the ${f === 'holds' ? 'note-ingest-holds' : 'private-sessions'} folder cannot be read, so no note is imported and what it holds cannot be listed`);
        fixes.push(`Make ${f === 'holds' ? summary.holdsFolder : summary.markersFolder} a folder you can read and write again; do not delete it, it holds the private-session records.`);
    }
    for (const d of summary.damaged) {
        if (d.folder === 'holds') {
            lines.push(`the hold record ${d.file} cannot be read, so no note is imported`);
            fixes.push(`${d.file} in ${summary.holdsFolder} cannot be repaired by hand. Deleting it is the last step and releases the notes it holds: they then import as ordinary notes, so if that session was private its content is stored.`);
        }
        else {
            lines.push(`the private-session marker ${d.file} cannot be read, so no note is imported`);
            fixes.push(`The session ${d.file} belongs to rebuilds it at its next hook. Only if that session has ended, delete ${d.file} in ${summary.markersFolder}: the notes that session wrote are then imported.`);
        }
    }
    for (const w of summary.waitingOnUnreadable) {
        lines.push(`${w.notes} note(s) held by ${w.file} could not be read, so the folder they are in waits on every note changed since ${new Date(w.since).toISOString().slice(0, 10)}`);
        fixes.push('Make the notes folder and its files readable by you again; the wait ends at the next import that can read them.');
    }
    const deadline = Date.now() + DOCTOR_PRIVACY_TOTAL_MS;
    const memesh = getMemeshDirFromDbPath();
    for (const u of summary.unsettled) {
        let now2 = '';
        let settled = false;
        const transcript = knownTranscriptPath(u.transcript);
        if (u.transcript !== undefined && transcript === undefined) {
            now2 = 'the record names a transcript outside the known folders, so it is not read';
        }
        else if (Date.now() < deadline) {
            const state = decidePrivacy({ sessionId: u.session.replace(/\.json$/, ''), transcriptPath: transcript, memeshDir: memesh, deadlineAt: Math.min(deadline, Date.now() + DOCTOR_PRIVACY_CHECK_MS), cacheDir: path.join(memesh, 'private-check-cache') });
            settled = state.state !== 'unchecked';
            now2 = state.state === 'no' ? 'it can be checked now and is not private: the next import releases them'
                : state.state === 'yes' ? 'it is private: the next import holds them for good'
                    : 'it still cannot be checked';
        }
        lines.push(`${u.notes} note(s) of ${u.file} are held because the session could not be checked (${u.reasonText}; held since ${new Date(u.since).toISOString().slice(0, 10)})${now2 ? `; ${now2}` : ''}`);
        if (settled) {
        }
        else if (u.kind === 'persistent') {
            fixes.push(`This reason does not pass on its own. To release the notes anyway, delete ${u.file} in ${summary.holdsFolder}: they then import as ordinary notes, so if the session was private its content is stored.`);
        }
        else {
            fixes.push('This reason can pass on its own: the session is checked again at every import and its notes are let through once it can be checked and is not private.');
        }
    }
    const notes = summary.unsettled.reduce((n, u) => n + u.notes, 0);
    return createCheck('private-note-holds', 'Notes kept out of memory', 'warn', `${lines.join('; ')}.`, [...new Set(fixes)].join(' '), { params: { sessions: summary.unsettled.length, notes } });
}
function createCheck(id, label, status, summary, fix, i18n, fixId) {
    return { id, label, status, summary, fix, code: i18n?.code, params: i18n?.params, fixId };
}
function createInfo(id, label, summary, fix) {
    return { id, label, status: 'pass', summary, fix, informational: true };
}
function inspectAgentMessageStorage(db, databasePath, policy) {
    try {
        const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_messages'").get();
        if (!present?.present)
            return undefined;
        const report = getAgentMessageStorageReport(db, { databasePath });
        const quota = policy?.storage_quota_bytes;
        const invalidQuota = quota !== undefined && (!Number.isSafeInteger(quota) || quota < 0);
        const quotaText = quota === undefined
            ? 'quota not configured'
            : !invalidQuota
                ? `quota ${formatStorageBytes(quota)} (${formatStorageBytes(report.payload_bytes)} logical payload used)`
                : 'configured quota is invalid';
        const retentionText = report.expired_pending_message_count === 0
            ? 'messages are kept one day, then deleted'
            : `messages are kept one day, then deleted; ${report.expired_pending_message_count} past that are waiting for the next expiry pass`;
        const walText = report.wal_file_bytes === null
            ? 'WAL size unavailable'
            : `WAL ${formatStorageBytes(report.wal_file_bytes)}`;
        const databaseText = report.database_file_bytes === null
            ? 'database file size unavailable'
            : `database file ${formatStorageBytes(report.database_file_bytes)}`;
        const summary = `${report.message_count} message(s), ${formatStorageBytes(report.payload_bytes)} logical payload `
            + `(${report.protected_unresolved_message_count} unresolved/protected); ${formatStorageBytes(report.reusable_freelist_bytes)} `
            + `SQLite freelist reusable; ${databaseText}; ${walText}; ${quotaText}; ${retentionText}. `
            + 'Doctor only read this state: it did not delete messages, checkpoint WAL, or run VACUUM.';
        if (invalidQuota) {
            return createCheck('agent_message_storage', 'Agent message storage', 'warn', `${summary} Send enforcement rejects this quota configuration; use a canonical non-negative safe decimal integer.`, `Set ${AGENT_MESSAGE_STORAGE_QUOTA_ENV} to 0 or a positive decimal integer within the safe integer range, then re-run memesh doctor.`);
        }
        return createInfo('agent_message_storage', 'Agent message storage', summary);
    }
    catch {
        return undefined;
    }
}
function inspectAgentMessageExpiry(db, nowMs = Date.now()) {
    try {
        const present = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('agent_messages', 'agent_message_expiry_runs')").get();
        if (present?.n !== 2)
            return undefined;
        const waiting = getAgentMessageStorageReport(db, {}).expired_pending_message_count;
        const how = 'It runs by itself while the MeMesh router, MCP server or memesh serve is running; start a MeMesh session and re-run memesh doctor.';
        const file = databaseFile(db);
        if (file !== '') {
            try {
                fs.accessSync(file, fs.constants.W_OK);
            }
            catch {
                const writeBack = ownerWriteCommand(file) ?? `run: chmod u+w ${shellQuote(file)}`;
                return createCheck('agent_message_expiry', 'Agent message expiry', 'warn', `The database file ${file} cannot be written by this user, so the one-day expiry cannot delete anything (messages past their day are hidden but stay on disk).`, `Make the database writable (${writeBack}), then re-run memesh doctor.`);
            }
        }
        const stuck = db.prepare("SELECT started_at_ms, expired_message_count, backup_path FROM agent_message_expiry_runs WHERE outcome = 'started' ORDER BY run_id DESC LIMIT 1").get();
        const ago = (ms) => (ms < 90_000 ? 'under a minute ago'
            : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} minute(s) ago`
                : `${Math.round(ms / 3_600_000 * 10) / 10} hour(s) ago`);
        const last = lastAgentMessageExpiryRun(db);
        const finishedCheck = () => {
            if (!last) {
                return waiting > 0
                    ? createCheck('agent_message_expiry', 'Agent message expiry', 'warn', `No expiry pass has run on this database, and ${waiting} message(s) are past their one day. ${how}`, how)
                    : createInfo('agent_message_expiry', 'Agent message expiry', `No expiry pass has run yet. Messages are kept one day, then deleted. ${how}`);
            }
            const did = `${last.expired_message_count} message(s) deleted (${last.unread_message_count} with no intake, acknowledgement, disposition or reply; ${last.notice_count} sender notice(s)), `
                + `${last.presence_fact_count} presence fact(s) and ${last.connection_count} connection(s) cleared`;
            const latestArchive = latestAgentMessageExpiryArchive(db);
            const archive = latestArchive ? inspectAgentMessageArchive(db, latestArchive) : undefined;
            const backup = !latestArchive || !archive ? ''
                : archive.kind === 'missing' ? ` The archive of deleted messages, ${latestArchive}, is not there any more.`
                    : archive.kind === 'unusable' ? ` The archive of deleted messages, ${latestArchive}, cannot be used: ${archive.reason}.`
                        : archive.messages > 0 ? ` Deleted messages are kept one more day in ${latestArchive} (${archive.messages} there now).`
                            : ` The archive ${latestArchive} holds no deleted message now (each is kept there one more day after it is deleted).`;
            const summary = `Last pass ${ago(nowMs - last.finished_at_ms)} (${last.outcome}, started by ${last.trigger_source}): ${did}.${backup}${last.detail ? ` ${last.detail}.` : ''}`;
            const archiveFix = latestArchive
                ? `for the archive ${latestArchive}: free disk space, give the owner read and write access to it and to its folder, or move it away if it is not a MeMesh archive`
                : 'for the archive: free disk space or permissions on the backups folder next to the database';
            if (AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES.has(last.outcome)) {
                return createCheck('agent_message_expiry', 'Agent message expiry', 'warn', summary, `Nothing is deleted while this fails. Read the detail above, fix it (${archiveFix}; for a read-only database: make it writable), then re-run memesh doctor.`);
            }
            if (archive?.kind === 'unusable') {
                return createCheck('agent_message_expiry', 'Agent message expiry', 'warn', summary, `The next pass that has messages to delete cannot copy them, so it deletes nothing. Fix it (${archiveFix}), then re-run memesh doctor.`);
            }
            const lastSuccess = db.prepare(`
        SELECT MAX(finished_at_ms) AS at FROM agent_message_expiry_runs
        WHERE outcome NOT IN ('started', 'skipped_concurrent', 'database_busy', 'interrupted', ${[...AGENT_MESSAGE_EXPIRY_FAILED_OUTCOMES].map((o) => `'${o}'`).join(', ')})
      `).get().at;
            if (waiting > 0 && (lastSuccess === null || nowMs - lastSuccess > 2 * AGENT_MESSAGE_EXPIRY_INTERVAL_MS)) {
                const since = lastSuccess === null ? 'no pass has done its work yet' : `the last pass that did its work finished ${ago(nowMs - lastSuccess)}`;
                return createCheck('agent_message_expiry', 'Agent message expiry', 'warn', `${summary} ${waiting} message(s) are past their one day and ${since}. ${how}`, how);
            }
            return createInfo('agent_message_expiry', 'Agent message expiry', summary);
        };
        if (!stuck)
            return finishedCheck();
        const sinceMs = nowMs - stuck.started_at_ms;
        const old = sinceMs > 10 * 60_000;
        const unfinished = `A pass started ${ago(sinceMs)} and has not finished`
            + (old ? ' (the process running it was probably stopped)' : ' (it is still working, or it was stopped a moment ago)')
            + `; it had deleted ${stuck.expired_message_count} message(s) when it last saved its count`
            + (stuck.backup_path && fs.existsSync(stuck.backup_path) ? `, and those are in ${stuck.backup_path}` : '')
            + '. If it was stopped, the next pass takes over once its lease runs out (at most three minutes after its last batch), closes it as interrupted and carries on.';
        if (!last) {
            return old
                ? createCheck('agent_message_expiry', 'Agent message expiry', 'warn', unfinished, how)
                : createInfo('agent_message_expiry', 'Agent message expiry', unfinished);
        }
        const before = finishedCheck();
        return old || before.status !== 'pass'
            ? createCheck('agent_message_expiry', 'Agent message expiry', 'warn', `${unfinished} ${before.summary}`, before.fix ?? how)
            : createInfo('agent_message_expiry', 'Agent message expiry', `${unfinished} ${before.summary}`);
    }
    catch {
        return undefined;
    }
}
function noDaemonReason(detailJson) {
    try {
        return JSON.parse(detailJson)?.detail?.reason === 'no_daemon';
    }
    catch {
        return false;
    }
}
function inspectCodexQueueDaemon(db) {
    try {
        const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_message_receipts'").get();
        if (!present?.present)
            return undefined;
        const rows = db.prepare(`
      SELECT project, recipient, detail_json, created_at FROM agent_message_receipts
      WHERE receipt_kind = 'host_activation'
        AND actor = 'memesh-router'
        AND idempotency_key LIKE 'codex-queue-release-%'
        AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC, rowid DESC
    `).all();
        if (rows.length === 0) {
            return createInfo('codex-queue-daemon', 'Codex stuck-message release', 'No Codex host_activation receipts in the last 7 days. The Codex stuck-message release has not run recently, so its app-server-daemon dependency has not been exercised either way.');
        }
        const latestPerThread = new Map();
        for (const row of rows) {
            const key = `${row.project}\u0000${row.recipient}`;
            if (!latestPerThread.has(key))
                latestPerThread.set(key, row);
        }
        const stuck = [...latestPerThread.values()].filter((row) => noDaemonReason(row.detail_json));
        if (stuck.length === 0) {
            return createInfo('codex-queue-daemon', 'Codex stuck-message release', `${latestPerThread.size} Codex thread(s) ran the stuck-message release in the last 7 days; the latest run in each found the app-server daemon. Nothing is waiting on it.`);
        }
        const named = stuck
            .map((row) => `${row.recipient} in ${row.project} (${sqliteUtcToIso(row.created_at)})`)
            .join(', ');
        return createCheck('codex-queue-daemon', 'Codex stuck-message release', 'warn', `${stuck.length} Codex thread(s) last ran the stuck-message release without the app-server daemon: ${named}. A MeMesh message queued there after an interrupted turn stays in that thread's queue until you send the thread a prompt.`, 'Send a prompt in each thread named above to drain its queue. To restore the automatic release, run Codex with its app-server daemon (avoid `--no-daemon`).');
    }
    catch (err) {
        return createCheck('codex-queue-daemon', 'Codex stuck-message release', 'warn', `Could not read the Codex host_activation receipts: ${err instanceof Error ? err.message : String(err)}`, 'Run `memesh doctor` again; if this persists, check the database rows above for the underlying error.');
    }
}
function countUnsettledNotices(db, codes) {
    const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_attempts'").get();
    if (!present?.present)
        return undefined;
    const row = db.prepare(`
    SELECT COUNT(DISTINCT a.delivery_id) AS unsettled
    FROM agent_dispatch_attempts a
    WHERE a.failure_code IN (${codes.map(() => '?').join(', ')})
      AND a.created_at > datetime('now', '-7 days')
      AND a.attempt_number = (
        SELECT MAX(l.attempt_number) FROM agent_dispatch_attempts l WHERE l.delivery_id = a.delivery_id
      )
      AND NOT EXISTS (SELECT 1 FROM agent_host_accepts h WHERE h.delivery_id = a.delivery_id)
      AND NOT EXISTS (
        SELECT 1 FROM agent_message_deliveries d JOIN agent_message_receipts r
          ON r.message_id = d.message_id AND r.project = d.project AND r.recipient = d.recipient
        WHERE d.delivery_id = a.delivery_id AND r.receipt_kind IN ${HANDLED_RECEIPT_KINDS_SQL}
      )
  `).get(...codes);
    const count = Number(row?.unsettled);
    return count > 0 ? count : undefined;
}
function inspectHeldNotices(db) {
    const found = countNoticeFailures(db, ['notice_not_confirmed', 'notice_held']);
    if (found === undefined)
        return undefined;
    if (typeof found !== 'number') {
        return createCheck('held-notices', 'Message notices not shown to Claude', 'warn', found.unreadable, UNREADABLE_ATTEMPTS_FIX);
    }
    return createCheck('held-notices', 'Message notices not shown to Claude', 'warn', `${found} message(s) in the last 7 days reached a Claude Code session's socket but their notice never showed up in its conversation. Possible causes: Claude Code is holding the notice for its user to approve or deny (for example when the sender does not state a permission mode and that session bypasses permission prompts, or when the two sessions' permission modes differ), the session was busy or has stopped, or it dropped the notice. MeMesh cannot tell these apart, and cannot see whether the user denied a held notice. The messages are safe in the inbox and are raised at the session's next prompt or turn end.`, 'To get the live notice, set "crossSessionInbound" to "accept" in that Claude Code session\'s settings, or install the MeMesh Channel. Otherwise the message appears at the next prompt.');
}
function inspectUnreadableTranscripts(db) {
    const found = countNoticeFailures(db, ['transcript_unavailable', 'transcript_not_found']);
    if (found === undefined)
        return undefined;
    if (typeof found !== 'number') {
        return createCheck('unreadable-transcripts', 'Claude Code conversation record not readable', 'warn', found.unreadable, UNREADABLE_ATTEMPTS_FIX);
    }
    return createCheck('unreadable-transcripts', 'Claude Code conversation record not readable', 'warn', `${found} message(s) in the last 7 days could not be checked: MeMesh could not read the Claude Code session's conversation record, so it could not tell whether the notice arrived. The messages are safe in the inbox and are raised at the session's next prompt or turn end.`, 'Check that CLAUDE_CONFIG_DIR (when you set it) points at the folder Claude Code writes its conversation records to, and that the MeMesh MCP server is started from the project (MEMESH_PROJECT_ROOT or CLAUDE_PROJECT_DIR set, or a single workspace root). Then start a new Claude Code session.');
}
const UNREADABLE_ATTEMPTS_FIX = 'Run `memesh doctor` again; if this persists, check the database rows above for the underlying error.';
function countNoticeFailures(db, codes) {
    try {
        return countUnsettledNotices(db, codes);
    }
    catch (err) {
        return { unreadable: `Could not read the message dispatch attempts: ${err instanceof Error ? err.message : String(err)}` };
    }
}
function inspectProjectIdentitySplit(db) {
    let splits;
    try {
        splits = findProjectIdentitySplits(db);
    }
    catch (err) {
        return createCheck('project-identity-split', 'Project tags', 'warn', `The project tag check could not run (${err instanceof Error ? err.message : String(err)}), so a project split is not ruled out.`, 'Run `memesh kg rename-project` to list every project tag.');
    }
    if (splits.length === 0)
        return undefined;
    const total = splits.reduce((sum, split) => sum + split.activeMemories, 0);
    return createCheck('project-identity-split', 'Project tags', 'warn', `${total} active ${total === 1 ? 'memory' : 'memories'} in ${splits.length} ${splits.length === 1 ? 'project is' : 'projects are'} `
        + "filed under a plain project name (project:<name>) that the project's sessions never read; they use the full id (project:<name>~<hash>).", 'Run `memesh kg rename-project` to list every project tag with its count. For a plain name listed next to an id of the same name, '
        + 'kg rename-project --from <name> --to <id> previews moving its memories to that id, and the same command with --apply moves them '
        + '(it backs the database up first). A shared name does not prove one project: if a different repository used that name, leave it.');
}
function inspectCodexSessionSetup(codexPluginCacheDetected, existsSyncImpl) {
    if (!codexPluginCacheDetected)
        return null;
    const configPath = path.join(getMemeshDirFromDbPath(), 'hosts', 'codex-session.json');
    if (existsSyncImpl(configPath)) {
        return createInfo('codex-session-setup', 'Codex ordinary-session notifications', 'A Codex identity override file is present and will be validated at SessionStart. A valid override applies only in its configured workspace; other Codex plugin sessions use automatic thread-scoped identities. A cached plugin copy does not prove a live registration; use `memesh message discover --project <project>` to read current presence.');
    }
    return createInfo('codex-session-setup', 'Codex ordinary-session notifications', 'No explicit identity override is configured. When the Codex plugin is enabled, each startup or resumed thread registers automatically under a thread-scoped identity. A cached plugin copy does not prove a live registration; use `memesh message discover --project <project>` to read current presence.');
}
function configuredAgentMessageStoragePolicy(explicit) {
    if (explicit !== undefined)
        return explicit;
    const quotaRaw = process.env[AGENT_MESSAGE_STORAGE_QUOTA_ENV];
    if (quotaRaw === undefined || quotaRaw === '')
        return undefined;
    if (!/^(0|[1-9][0-9]*)$/.test(quotaRaw)) {
        return { storage_quota_bytes: Number.NaN };
    }
    const parsed = Number(quotaRaw);
    return { storage_quota_bytes: Number.isSafeInteger(parsed) ? parsed : Number.NaN };
}
function formatStorageBytes(value) {
    if (!Number.isFinite(value) || value < 0)
        return 'unknown size';
    if (value < 1024)
        return `${value} B`;
    if (value < 1024 * 1024)
        return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
function parseJsonFile(filePath, readFileSyncImpl) {
    try {
        const raw = readFileSyncImpl(filePath, 'utf8');
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object') {
            return { ok: false, error: 'JSON root must be an object.' };
        }
        return { ok: true, value: value };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : 'unknown parse error',
        };
    }
}
function inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl) {
    const configPath = getConfigPathImpl();
    if (!existsSyncImpl(configPath)) {
        return createCheck('config', 'Config', 'pass', `No config file yet (${configPath}); default settings are in effect.`, 'Optional: run memesh config list to inspect settings.');
    }
    try {
        const raw = readFileSyncImpl(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return createCheck('config', 'Config', 'fail', `${configPath} parsed but is not a JSON object — every setting is being ignored.`, `Fix or remove ${configPath}, then re-run memesh doctor.`, { code: 'config-parse.not-object', params: { path: configPath } });
        }
        const retiredKeys = findRetiredConfigKeys(parsed);
        if (retiredKeys.length > 0) {
            const keys = retiredKeys.join(', ');
            return createCheck('config', 'Config', 'warn', `${configPath} is valid JSON but still contains ${retiredKeys.length} retired top-level setting(s) (${keys}). ` +
                'This version ignores them, but legacy provider credentials or settings may remain on disk.', `Review ${configPath} locally and remove only those retired top-level keys. ` +
                'Do not paste the file into an issue because it may contain credentials. Then run memesh doctor again.', {
                code: 'config-parse.retired-settings',
                params: { path: configPath, count: retiredKeys.length, keys },
            }, 'config-retired-settings');
        }
        return createCheck('config', 'Config', 'pass', `${configPath} is valid JSON and its settings are in effect.`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createCheck('config', 'Config', 'fail', `${configPath} could not be read or parsed (${msg}). Its settings are being ignored right now.`, `Fix the JSON or remove the file to fall back to defaults: mv ${shellQuote(configPath)} ${shellQuote(`${configPath}.bak`)}`, { code: 'config-parse.unreadable', params: { path: configPath, detail: msg } });
    }
}
const MCP_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
function declaredMcpManifest(packageRoot, readFileSyncImpl) {
    const parsed = parseJsonFile(path.join(packageRoot, '.claude-plugin', 'plugin.json'), readFileSyncImpl);
    if (!parsed.ok)
        return null;
    const declared = parsed.value.mcpServers;
    if (typeof declared !== 'string' || !declared.startsWith('./'))
        return null;
    return declared.slice(2);
}
function inspectMcpConfig(packageRoot, installChannel, existsSyncImpl, readFileSyncImpl, env) {
    const relativeManifest = declaredMcpManifest(packageRoot, readFileSyncImpl);
    if (relativeManifest === null) {
        return createCheck('mcp-config', 'MCP config', 'fail', '.claude-plugin/plugin.json declares no `mcpServers` path, so Claude Code has no MeMesh MCP server to start.', 'Reinstall MeMesh so the plugin manifest and the MCP manifest it names are both restored.', { code: 'mcp-config.missing' });
    }
    const label = relativeManifest;
    const mcpPath = path.join(packageRoot, relativeManifest);
    if (!existsSyncImpl(mcpPath)) {
        return createCheck('mcp-config', 'MCP config', 'fail', `${label} is missing.`, 'Reinstall MeMesh so the plugin manifest and the MCP manifest it names are both restored.', { code: 'mcp-config.missing' });
    }
    const parsed = parseJsonFile(mcpPath, readFileSyncImpl);
    if (!parsed.ok) {
        return createCheck('mcp-config', 'MCP config', 'fail', `${label} is not valid JSON.`, `Fix ${mcpPath} so Claude Code can read the MCP server definition.`, { code: 'mcp-config.invalid-json', params: { path: mcpPath } });
    }
    const server = parsed.value.mcpServers?.memesh;
    if (!server || typeof server.command !== 'string') {
        return createCheck('mcp-config', 'MCP config', 'fail', `${label} does not define a usable \`memesh\` MCP server entry.`, `Reinstall MeMesh or restore the \`mcpServers.memesh\` entry in \`${label}\`.`, { code: 'mcp-config.no-entry' });
    }
    const args = Array.isArray(server.args) ? server.args : [];
    const entry = typeof args[0] === 'string' ? args[0] : null;
    if (entry) {
        const pluginRoot = installChannel === 'plugin-marketplace' ? packageRoot : (env.CLAUDE_PLUGIN_ROOT || null);
        if (entry.includes(MCP_PLACEHOLDER) && pluginRoot === null) {
            return createCheck('mcp-config', 'MCP config', 'warn', `${label} starts \`${entry}\`. NOT VERIFIED: \`${MCP_PLACEHOLDER}\` is substituted by the Claude Code plugin runtime, and this is a ${installChannel} install with CLAUDE_PLUGIN_ROOT unset — so the file it names was not checked.`, `Verify it the way the plugin runtime would: CLAUDE_PLUGIN_ROOT=${shellQuote(packageRoot)} memesh doctor`, { code: 'mcp-config.placeholder-unresolved', params: { entry, channel: installChannel } });
        }
        const resolved = pluginRoot === null
            ? path.resolve(packageRoot, entry)
            : path.resolve(entry.replaceAll(MCP_PLACEHOLDER, pluginRoot));
        if (!existsSyncImpl(resolved)) {
            return createCheck('mcp-config', 'MCP config', 'fail', `${label} starts \`${entry}\`, and that file is not in this install — so every memesh MCP tool fails to start.`, `Reinstall MeMesh; if you edited \`${label}\` by hand, point it back at \`${MCP_PLACEHOLDER}/dist/mcp/server.js\`.`, { code: 'mcp-config.entry-missing', params: { entry, resolved } });
        }
    }
    return createCheck('mcp-config', 'MCP config', 'pass', `${label} is present, defines the memesh MCP server, and the script it starts exists.`);
}
function extractHookScriptPaths(hooksConfig, packageRoot) {
    const hooks = hooksConfig.hooks;
    if (!hooks)
        return [];
    const scripts = new Set();
    for (const entries of Object.values(hooks)) {
        if (!Array.isArray(entries))
            continue;
        for (const entry of entries) {
            if (!Array.isArray(entry.hooks))
                continue;
            for (const hook of entry.hooks) {
                if (typeof hook.command !== 'string')
                    continue;
                const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
                scripts.add(path.join(packageRoot, command));
            }
        }
    }
    return Array.from(scripts).sort();
}
function inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl) {
    const hooksPath = path.join(packageRoot, 'hooks', 'hooks.json');
    if (!existsSyncImpl(hooksPath)) {
        return [
            createCheck('hooks-config', 'Hooks config', 'fail', 'hooks/hooks.json is missing.', 'Restore `hooks/hooks.json` from the package or reinstall MeMesh.', { code: 'hooks-config.missing' }),
        ];
    }
    const parsed = parseJsonFile(hooksPath, readFileSyncImpl);
    if (!parsed.ok) {
        return [
            createCheck('hooks-config', 'Hooks config', 'fail', 'hooks/hooks.json is not valid JSON.', `Fix ${hooksPath} so Claude Code can load the hook definitions.`, { code: 'hooks-config.invalid-json', params: { path: hooksPath } }),
        ];
    }
    const parsedHooks = parsed.value.hooks;
    const hookTypes = parsedHooks && typeof parsedHooks === 'object' && !Array.isArray(parsedHooks)
        ? Object.keys(parsedHooks)
        : [];
    const missingTypes = EXPECTED_HOOK_TYPES.filter((type) => !hookTypes.includes(type));
    const configCheck = missingTypes.length > 0
        ? createCheck('hooks-config', 'Hooks config', 'fail', `hooks/hooks.json is missing expected hook types: ${missingTypes.join(', ')}.`, 'Restore the shipped hook configuration or reinstall MeMesh.', { code: 'hooks-config.missing-types', params: { types: missingTypes.join(', ') } })
        : createCheck('hooks-config', 'Hooks config', 'pass', `hooks/hooks.json is present with ${hookTypes.length} hook types configured.`);
    const scriptPaths = extractHookScriptPaths(parsed.value, packageRoot);
    if (scriptPaths.length === 0) {
        return [
            configCheck,
            createCheck('hook-scripts', 'Hook scripts', 'fail', 'hooks/hooks.json parsed, but yields zero hook script commands — hooks can never fire.', 'Restore the shipped hook configuration or reinstall MeMesh.', { code: 'hook-scripts.none' }),
        ];
    }
    const missingScripts = scriptPaths.filter((scriptPath) => !existsSyncImpl(scriptPath));
    if (missingScripts.length > 0) {
        return [
            configCheck,
            createCheck('hook-scripts', 'Hook scripts', 'fail', `Missing hook scripts: ${missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`, 'Restore the missing files from the package or reinstall MeMesh.', { code: 'hook-scripts.missing', params: { files: missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ') } }),
        ];
    }
    if (platform !== 'win32') {
        const nonExecutable = scriptPaths.filter((scriptPath) => {
            const mode = statSyncImpl(scriptPath).mode;
            return (mode & 0o111) === 0;
        });
        if (nonExecutable.length > 0) {
            return [
                configCheck,
                createCheck('hook-scripts', 'Hook scripts', 'fail', `Hook scripts are not executable: ${nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`, 'Run `npm run build` from the repo checkout or `chmod +x scripts/hooks/*.js` for a local repair.', { code: 'hook-scripts.not-executable', params: { files: nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ') } }),
            ];
        }
    }
    return [
        configCheck,
        createCheck('hook-scripts', 'Hook scripts', 'pass', `All ${scriptPaths.length} hook scripts are present${platform === 'win32' ? '' : ' and executable'}.`),
    ];
}
function inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir, installChannel, installedPluginsPath, pluginHost) {
    const markerPath = path.join(memeshDir, 'install-hooks.json');
    if (!existsSyncImpl(markerPath)) {
        if (installChannel === 'plugin-marketplace') {
            const runtime = pluginHost === 'codex' ? 'Codex CLI' : 'Claude Code';
            return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', `Wired via the ${runtime} plugin runtime (this is a plugin-marketplace install). The install-hooks marker is not used on this install path.`);
        }
        if (detectPluginRuntime(installedPluginsPath)) {
            return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', 'Wired via the Claude Code plugin runtime (found in installed_plugins.json). This copy is not the one doing the capturing — the plugin manages the hooks.');
        }
        const claudeHere = claudeCodePresent(existsSyncImpl, isOnPath);
        const codexHere = codexPresent(existsSyncImpl, isOnPath);
        const geminiHere = geminiPresent(isOnPath);
        if (!claudeHere && (codexHere || geminiHere)) {
            const hostName = codexHere ? 'Codex' : 'Gemini CLI';
            return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', `Claude Code was not found on this machine (${hostName} is), so there are no Claude Code hooks to wire. This row does not check ${hostName}'s own hooks; the Capture liveness row shows whether any hook has recorded a result.`, undefined, { code: 'hook-wiring.no-claude-code', params: { captureWired: 0 } });
        }
        if (!claudeHere && !codexHere && !geminiHere) {
            return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', 'No agent host was found on this machine (looked for Claude Code, Codex and Gemini CLI: their commands on PATH, and the Claude Code and Codex configuration directories), so memesh has nothing to connect to yet.', NO_HOST_NEXT_STEP, { code: 'hook-wiring.no-host' });
        }
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', 'memesh is not connected to Claude Code yet, so nothing gets remembered automatically from your sessions.', 'Run `memesh install-hooks` once to connect it, then `memesh doctor` to confirm.', { code: 'hook-wiring.no-marker' }, 'install-hooks');
    }
    const parsed = parseJsonFile(markerPath, readFileSyncImpl);
    if (!parsed.ok) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', `install-hooks marker at ${markerPath} is unreadable.`, 'Re-run `memesh install-hooks` to refresh the marker.', { code: 'hook-wiring.marker-unreadable', params: { path: markerPath } });
    }
    const marker = parsed.value;
    if (typeof marker.settings_path !== 'string') {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', 'install-hooks marker is malformed (missing settings_path).', 'Re-run `memesh install-hooks`.', { code: 'hook-wiring.marker-malformed' });
    }
    if (!existsSyncImpl(marker.settings_path)) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Marker recorded settings at ${marker.settings_path} but the file no longer exists. Hooks are not wired.`, 'Re-run `memesh install-hooks`.', { code: 'hook-wiring.settings-missing', params: { path: String(marker.settings_path) } });
    }
    const settingsParsed = parseJsonFile(marker.settings_path, readFileSyncImpl);
    if (!settingsParsed.ok) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `${marker.settings_path} is no longer valid JSON, so nothing can read your hook wiring — including memesh.`, `Repair the JSON, or move the file aside (\`mv ${shellQuote(String(marker.settings_path))} ${shellQuote(`${marker.settings_path}.broken`)}\`) — memesh keeps timestamped \`.bak-pre-memesh-*\` copies next to it. Then run \`memesh install-hooks\`.`, { code: 'hook-wiring.settings-invalid', params: { path: String(marker.settings_path) } });
    }
    const CAPTURE_EVENTS = new Set(['Stop', 'PostToolUse', 'PreCompact']);
    const hooks = settingsParsed.value.hooks;
    let hasMemeshHook = false;
    let hasCaptureHook = false;
    let missingScript = null;
    if (hooks && typeof hooks === 'object') {
        for (const [event, entries] of Object.entries(hooks)) {
            if (!Array.isArray(entries))
                continue;
            for (const entry of entries) {
                const cmds = entry.hooks;
                if (!Array.isArray(cmds))
                    continue;
                for (const c of cmds) {
                    const cmd = c;
                    if (cmd._memesh !== true)
                        continue;
                    hasMemeshHook = true;
                    if (CAPTURE_EVENTS.has(event))
                        hasCaptureHook = true;
                    if (missingScript === null && typeof cmd.command === 'string'
                        && path.isAbsolute(cmd.command) && !existsSyncImpl(cmd.command)) {
                        missingScript = cmd.command;
                    }
                }
            }
        }
    }
    if (missingScript !== null) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `A wired memesh hook points at ${missingScript}, which no longer exists — the agent invokes a missing file on every matching event. This is usually residue from an upgrade that retired the hook.`, 'Run `memesh install-hooks` to re-wire (it now removes retired entries), then restart your agent.', { code: 'hook-wiring.script-missing', params: { path: missingScript } });
    }
    if (!hasMemeshHook) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Marker recorded a memesh install at ${marker.settings_path}, but no _memesh:true hook entries are present anymore. Settings drifted (manual edit?) or memesh was uninstalled out-of-band.`, 'Re-run `memesh install-hooks` to re-wire.', { code: 'hook-wiring.entries-removed', params: { path: String(marker.settings_path) } });
    }
    if (typeof marker.plugin_root === 'string' && !existsSyncImpl(marker.plugin_root)) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Hook commands point at ${marker.plugin_root}, which no longer exists (likely after an npm-global path change).`, 'Re-run `memesh install-hooks` to refresh paths.', { code: 'hook-wiring.root-moved', params: { path: String(marker.plugin_root) } });
    }
    return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', `Wired in ${marker.settings_path} (scope: ${marker.scope ?? 'user'}, version: ${marker.version ?? 'unknown'}).`, undefined, { params: { captureWired: hasCaptureHook ? 1 : 0 } });
}
function inspectHookActivity(openDatabaseImpl, closeDatabaseImpl, existsSyncImpl = fs.existsSync, statSyncImpl = fs.statSync, wiringPresent = true) {
    const TITLE = 'Hook activity';
    const captureOff = autoCaptureOffSource();
    if (captureOff === 'config') {
        return createCheck('hook-activity', TITLE, 'pass', 'Automatic capture is turned off (config autoCapture: false) — deliberately, so hook silence is expected. Re-enable it to resume capturing sessions.', undefined, { code: 'hook-activity.disabled' });
    }
    if (captureOff === 'env') {
        return createCheck('hook-activity', TITLE, 'pass', 'Automatic capture is turned off by MEMESH_AUTO_CAPTURE=false in this shell\'s environment. Doctor can only see its own environment — if your agent runs without this variable, capture there is unaffected.', undefined, { code: 'hook-activity.disabled-env' });
    }
    let db = null;
    try {
        db = openDatabaseImpl();
        const hookRunsTablePresent = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_runs'").get();
        const rows = hookRunsTablePresent
            ? db.prepare(`SELECT hook, last_run_at FROM hook_runs`).all()
            : [];
        const captured = db.prepare(`SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > datetime('now', '-24 hours')`).get(AUTO_CAPTURE_TAG)?.c ?? 0;
        const since = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'").get()?.value;
        const measuringHours = since !== undefined ? hoursSince(since) : null;
        const SKEW_TOLERANCE_H = 5 / 60;
        const KNOWN_HOOKS = new Set(['session-summary', 'post-commit', 'pre-compact']);
        const ages = new Map();
        for (const r of rows) {
            if (!KNOWN_HOOKS.has(r.hook))
                continue;
            const age = hoursSince(r.last_run_at);
            ages.set(r.hook, age !== null && age >= -SKEW_TOLERANCE_H ? Math.max(age, 0) : null);
        }
        if (ages.size > 0) {
            const capturedTail = captured > 0
                ? `${captured} memor${captured === 1 ? 'y' : 'ies'} captured in the last 24h.`
                : 'Nothing was worth saving in that time, which is normal — the loop still ran.';
            const staleUnknown = (hook) => createCheck('hook-activity', TITLE, 'fail', `The ${hook} hook's last-run timestamp cannot be read (corrupt, or stamped by a machine with a wrong clock). ` +
                'Capture health is unknown, which is not the same as healthy.', 'End one work session, then re-run `memesh doctor` — a fresh run overwrites the bad timestamp.', { code: 'hook-activity.stale-unknown', params: { hook } });
            const stale = (hook, age, status) => createCheck('hook-activity', TITLE, status, `The ${hook} hook last ran ${formatHoursAgo(Math.ceil(age))}. ` +
                'If you have worked since then, capture has stopped and nothing from those sessions was saved.', 'Restart your agent, then end one session and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.', { code: 'hook-activity.stale', params: { hook, hours: Math.ceil(age) } });
            const ssAge = ages.has('session-summary') ? ages.get('session-summary') : undefined;
            if (ssAge === null)
                return staleUnknown('session-summary');
            if (ssAge !== undefined) {
                if (ssAge <= 24) {
                    return createCheck('hook-activity', TITLE, 'pass', `The session-summary hook last ran ${formatHoursAgo(ssAge)} — auto-capture is alive. ${capturedTail}`);
                }
                if (ssAge <= 72)
                    return stale('session-summary', ssAge, 'warn');
                const ccWrites = db.prepare(`SELECT COUNT(*) as c FROM entities
           WHERE created_at > datetime('now', '-72 hours')
             AND json_valid(metadata)
             AND json_extract(metadata, '$.provenance.source_host') = 'claude-code'`).get()?.c ?? 0;
                if (ccWrites > 0)
                    return stale('session-summary', ssAge, 'fail');
                return createCheck('hook-activity', TITLE, 'warn', `The session-summary hook last ran ${formatHoursAgo(Math.ceil(ssAge))}, and no Claude Code writes landed in the last 3 days either. If this machine has moved to another agent (Codex / Gemini), this is expected; if you still use Claude Code here, capture has stopped.`, 'If you still use Claude Code on this machine: restart it, end one session, and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.', { code: 'hook-activity.stale-unconfirmed', params: { hook: 'session-summary', hours: Math.ceil(ssAge) } });
            }
            const known = [...ages.entries()].filter((e) => e[1] !== null);
            if (known.length === 0) {
                const [hook] = [...ages.keys()].sort();
                return staleUnknown(hook);
            }
            const [freshestHook, freshestAge] = known.sort((a, b) => a[1] - b[1])[0];
            if (freshestAge <= 24) {
                if (measuringHours !== null && measuringHours > 72) {
                    return createCheck('hook-activity', TITLE, 'warn', `The ${freshestHook} hook is stamping (last ran ${formatHoursAgo(freshestAge)}), but the session-summary hook has never run once in the ${Math.round(measuringHours)} hours since tracking began — session capture may be broken while commit capture hides it.`, 'End one work session and re-run `memesh doctor`. If session-summary still has not run, run `memesh install-hooks` and restart your agent.', { code: 'hook-activity.stop-silent', params: { hook: freshestHook, hours: Math.round(measuringHours) } });
                }
                return createCheck('hook-activity', TITLE, 'pass', `The ${freshestHook} hook last ran ${formatHoursAgo(freshestAge)} — auto-capture is alive. ` +
                    `(session-summary has not stamped yet — expected until a session with real work ends.) ${capturedTail}`);
            }
            return stale(freshestHook, freshestAge, 'warn');
        }
        if (since !== undefined && (measuringHours === null || measuringHours < 0)) {
            return createCheck('hook-activity', TITLE, 'pass', 'The hook-run tracking marker is unreadable — it will be re-stamped automatically the next time the database is opened for writing (any session, commit, or memesh command does it). Tracking restarts then.');
        }
        if (measuringHours === null || measuringHours < 24) {
            return createCheck('hook-activity', TITLE, 'pass', 'Hook-run tracking has only just started on this database — the first work session will fill it in.');
        }
        const markerPath = path.join(memeshDir(), 'install-hooks.json');
        if (existsSyncImpl(markerPath)) {
            try {
                if (Date.now() - statSyncImpl(markerPath).mtimeMs < 24 * 60 * 60 * 1000) {
                    return createCheck('hook-activity', TITLE, 'pass', 'Hooks were wired in the last day and no session has ended yet — normal for a fresh install.');
                }
            }
            catch { }
        }
        const legacyCaptured = db.prepare(`SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > ?`).get(AUTO_CAPTURE_TAG, since)?.c ?? 0;
        if (legacyCaptured > 0) {
            return createCheck('hook-activity', TITLE, 'warn', `No hook has stamped the heartbeat, but ${legacyCaptured} auto-capture memor${legacyCaptured === 1 ? 'y' : 'ies'} landed since tracking began — hooks from a version before heartbeat tracking are probably still running.`, 'Update the memesh hooks to the current version (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), then restart your agent.', { code: 'hook-activity.never-ran-legacy', params: { captured: legacyCaptured } });
        }
        if (!wiringPresent) {
            return createCheck('hook-activity', TITLE, 'warn', 'No capture hook has ever run — and no capture hook (Stop / PostToolUse / PreCompact) is confirmed wired on this machine, so there is nothing to run.', 'If you want automatic capture, run `memesh install-hooks`. If this install is MCP-only (Codex / Gemini), this is expected and safe to ignore.', { code: 'hook-activity.not-wired' });
        }
        return createCheck('hook-activity', TITLE, 'fail', `No capture hook has run since tracking began ${formatHoursAgo(measuringHours)}. ` +
            'Hook wiring is in place, so they should be executing and are not — nothing is being remembered.', 'Run `memesh doctor` after ending one work session. If this still says no hook has run, run `memesh install-hooks` and restart your agent.', { code: 'hook-activity.never-ran', params: { hours: Math.round(measuringHours) } });
    }
    catch (err) {
        if (err instanceof NoDatabaseYetError) {
            return createInfo('hook-activity', TITLE, 'No database yet, so no hook can have captured anything: hook activity is not checked until MeMesh has stored its first memory. Doctor does not create the database.');
        }
        if (isSchemaBehind(err))
            return createInfo('hook-activity', TITLE, `Not checked: ${schemaBehindNote()}`);
        const detail = err instanceof Error ? err.message : String(err);
        return createCheck('hook-activity', TITLE, 'fail', queryFailedSummary(err, detail, 'hook activity', 'Capture health is unknown, which is not the same as healthy.'), queryFailedFix(err), { code: 'hook-activity.query-failed', params: { detail } });
    }
    finally {
        try {
            if (db)
                closeDatabaseImpl();
        }
        catch { }
    }
}
const SAFE_HANDOFF_NAME = /^session-handoff:[A-Za-z0-9._-]+~[0-9a-f]{32}$/;
function archivedHandoffName(file) {
    if (!Object.hasOwn(file.hooks, 'handoff-capture'))
        return null;
    const names = new Set();
    for (const r of file.hooks['handoff-capture']) {
        if (r.outcome === 'skipped' && r.reason === SKIP_REASONS.handoffArchived && typeof r.entity === 'string')
            names.add(r.entity);
    }
    if (names.size !== 1)
        return null;
    const [name] = names;
    return SAFE_HANDOFF_NAME.test(name) ? name : null;
}
function archivedHandoffCheck(title, runs, name) {
    const summary = `handoff-capture: ${runs} runs, 0 writes — the session handoff was archived with \`forget\`, so it is not updated any more.`;
    if (name) {
        return createCheck('capture-liveness', title, 'warn', summary, `To turn it back on, run \`memesh remember --name ${name} --type session-handoff --obs restart --project ${name.slice(name.indexOf(':') + 1)}\`; the next Stop replaces it.`, { code: 'capture-liveness.handoff-archived', params: { runs, name } });
    }
    return createCheck('capture-liveness', title, 'warn', summary, 'To turn it back on, find its exact name with `memesh recall session-handoff --include-archived`, then remember anything under that name with type session-handoff; the next Stop replaces it.', { code: 'capture-liveness.handoff-archived-unnamed', params: { runs } });
}
const NO_HOST_NEXT_STEP = 'Install Claude Code or Codex (or Gemini CLI), then run `memesh setup` to connect memesh to it.';
const CODEX_NEXT_STEP = `Refresh the Codex plugin (\`${PLUGIN_REFRESH_COMMANDS.codex}\`), restart Codex, start one session, and re-run \`memesh doctor\`. If you just updated, start a session first — the records begin on the next hook run.`;
const GEMINI_NEXT_STEP = 'Gemini CLI connects to memesh as an MCP server only, so there are no memesh hooks to install on this machine.';
export function hostFixState(wiringCode, codexHere) {
    if (wiringCode === 'hook-wiring.no-host')
        return 'no-host';
    if (wiringCode === 'hook-wiring.no-claude-code')
        return codexHere ? 'codex' : 'gemini';
    return 'claude';
}
export function withHostFix(check, state) {
    if (state === 'claude' || check.status === 'pass' || !check.fix?.includes('install-hooks'))
        return check;
    const fix = state === 'no-host' ? NO_HOST_NEXT_STEP : state === 'codex' ? CODEX_NEXT_STEP : GEMINI_NEXT_STEP;
    return { ...check, fix, fixId: undefined };
}
function withRecordedHosts(result) {
    if (!result.report)
        return result;
    const hostsSeen = [...new Set(result.report.hooks.flatMap((h) => h.hosts))].sort();
    if (hostsSeen.length === 0)
        return result;
    return { ...result, check: { ...result.check, summary: `${result.check.summary} Hosts recorded: ${hostsSeen.join(', ')}.` } };
}
function inspectCaptureLiveness(openDatabaseImpl, closeDatabaseImpl, readFileSyncImpl = fs.readFileSync, memeshDirImpl = getMemeshDirFromDbPath, captureWired = true) {
    const TITLE = 'Capture liveness';
    if (autoCaptureOffSource() !== null) {
        return {
            check: createCheck('capture-liveness', TITLE, 'pass', 'Automatic capture is turned off, so there is nothing to keep alive. Re-enable it to resume capturing.'),
        };
    }
    let raw;
    try {
        raw = readFileSyncImpl(path.join(memeshDirImpl(), HOOK_OUTCOMES_FILENAME), 'utf8');
    }
    catch {
        raw = null;
    }
    const outcomeFile = parseHookOutcomes(raw);
    const hooks = summarizeHookOutcomes(outcomeFile);
    let db = null;
    let types;
    let neverRan;
    let measuringHours;
    let legacyCaptured = 0;
    let stampedCount;
    let newestHeartbeatHours = null;
    try {
        db = openDatabaseImpl();
        const rows = db.prepare(`SELECT e.type AS type,
              SUM(CASE WHEN e.created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last7,
              SUM(CASE WHEN e.created_at <= datetime('now', '-7 days')
                        AND e.created_at > datetime('now', '-14 days') THEN 1 ELSE 0 END) AS prev7
         FROM entities e
         JOIN tags t ON t.entity_id = e.id
        WHERE t.tag = ?
          AND e.created_at > datetime('now', '-14 days')
          AND e.type <> ?
        GROUP BY e.type`).all(AUTO_CAPTURE_TAG, SESSION_HANDOFF_TYPE);
        types = summarizeTypeTrends(rows.map((r) => ({
            type: String(r.type),
            last7: Number(r.last7) || 0,
            prev7: Number(r.prev7) || 0,
        })));
        const tablePresent = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_runs'").get();
        const heartbeats = tablePresent
            ? db.prepare('SELECT hook, last_run_at FROM hook_runs').all()
            : [];
        const stamped = new Set(heartbeats.map((r) => r.hook));
        stampedCount = stamped.size;
        for (const r of heartbeats) {
            const h = hoursSince(String(r.last_run_at));
            if (h !== null && (newestHeartbeatHours === null || h < newestHeartbeatHours))
                newestHeartbeatHours = h;
        }
        neverRan = FAIL_ELIGIBLE_HOOKS.filter((h) => !stamped.has(h));
        const since = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'").get()?.value;
        measuringHours = since !== undefined ? hoursSince(since) : null;
        if (since !== undefined) {
            legacyCaptured = db.prepare(`SELECT COUNT(DISTINCT e.id) as c FROM entities e
         JOIN tags t ON t.entity_id = e.id
        WHERE t.tag = ? AND e.created_at > ?`).get(AUTO_CAPTURE_TAG, since)?.c ?? 0;
        }
    }
    catch (err) {
        if (err instanceof NoDatabaseYetError) {
            return {
                check: createInfo('capture-liveness', TITLE, 'No database yet, so there is nothing to keep alive: capture liveness is not checked until MeMesh has stored its first memory. Doctor does not create the database.'),
            };
        }
        if (isSchemaBehind(err))
            return { check: createInfo('capture-liveness', TITLE, `Not checked: ${schemaBehindNote()}`) };
        const detail = err instanceof Error ? err.message : String(err);
        return {
            check: createCheck('capture-liveness', TITLE, 'fail', queryFailedSummary(err, detail, 'capture liveness', 'Whether anything is being saved is unknown, which is not the same as healthy.'), queryFailedFix(err), { code: 'capture-liveness.query-failed', params: { detail } }),
        };
    }
    finally {
        try {
            if (db)
                closeDatabaseImpl();
        }
        catch { }
    }
    const verdict = captureLivenessVerdict({ hooks, types, neverRanHooks: neverRan, measuringHours });
    const report = {
        status: verdict.status,
        hooks,
        types,
        neverRan: verdict.deadHooks,
    };
    if (verdict.status === 'FAIL') {
        const hook = verdict.deadHooks[0];
        if (!captureWired) {
            return {
                check: createCheck('capture-liveness', TITLE, 'warn', `The ${hook} hook has never run — but no capture hook (Stop / PostToolUse / PreCompact) is confirmed wired on this machine, so there is nothing that should be running.`, 'If you want automatic capture, run `memesh install-hooks`. If this install is MCP-only (Codex / Gemini / Cursor), this is expected and safe to ignore.', { code: 'capture-liveness.not-wired', params: { hook } }),
                report: { ...report, status: 'PASS_WITH_CONCERNS' },
            };
        }
        if (legacyCaptured > 0 && hooks.length === 0) {
            return {
                check: createCheck('capture-liveness', TITLE, 'warn', `The ${hook} hook has left no record and no heartbeat, but ${legacyCaptured} auto-capture memor${legacyCaptured === 1 ? 'y' : 'ies'} landed since tracking began — hooks from a version before outcome tracking are probably still running.`, 'Update the memesh hooks to the current version (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), then restart your agent.', { code: 'capture-liveness.never-ran-legacy', params: { hook, captured: legacyCaptured } }),
                report: { ...report, status: 'PASS_WITH_CONCERNS' },
            };
        }
        return {
            check: createCheck('capture-liveness', TITLE, 'fail', `The ${hook} hook has left no record and no heartbeat in the ${Math.round(measuringHours ?? 0)} hours since tracking began — it has never run, so nothing it would capture is being saved.`, 'Run `memesh install-hooks` and restart your agent, then end one work session and re-run `memesh doctor`.', { code: 'capture-liveness.never-ran', params: { hook, hours: Math.round(measuringHours ?? 0) } }),
            report,
        };
    }
    if (verdict.erroringHook) {
        const h = verdict.erroringHook;
        const day = h.lastErrorAt !== null && /^\d{4}-\d{2}-\d{2}/.test(h.lastErrorAt) ? ` on ${h.lastErrorAt.slice(0, 10)}` : '';
        const newest = Math.min(RECENT_ERROR_RUNS, h.triggeredRuns);
        return {
            check: createCheck('capture-liveness', TITLE, 'warn', `${h.hook}: ${h.recentErrors} of its ${newest} most recent runs ended in an error (${h.errors} in its recorded window); the latest was '${h.lastErrorReason}'${day}.`, h.hook === 'hermes-private-session'
                ? HERMES_MARKER_FIX
                : PRIVATE_STATE_ERROR_FIXES[h.lastErrorReason ?? ''] ?? 'The reason says what failed; `memesh doctor --json` has the per-hook figures. This row clears once the hook\'s most recent runs (those its trigger applied to) end without an error. If it keeps failing, run `memesh install-hooks` and restart your agent.', { params: { hook: h.hook } }),
            report,
        };
    }
    if (verdict.silentHook) {
        const h = verdict.silentHook;
        const reason = h.dominantSkipReason ?? 'no reason recorded';
        if (h.hook === 'handoff-capture' && reason === SKIP_REASONS.handoffArchived) {
            return { check: archivedHandoffCheck(TITLE, h.triggeredRuns, archivedHandoffName(outcomeFile)), report };
        }
        return {
            check: createCheck('capture-liveness', TITLE, 'warn', `${h.hook}: ${h.triggeredRuns} runs, 0 writes — '${reason}'. The hook is alive and deciding there is nothing to save every single time, which is also what a broken capture path looks like.`, 'Run `memesh doctor --json` for the per-hook figures. If the reason does not describe your usage, run `memesh install-hooks` and restart your agent.', { code: 'capture-liveness.silent-hook', params: { hook: h.hook, runs: h.triggeredRuns, reason } }),
            report,
        };
    }
    if (hooks.length === 0 && stampedCount > 0
        && measuringHours !== null && measuringHours > NEVER_RAN_GRACE_HOURS) {
        const lastHeartbeat = newestHeartbeatHours === null ? null : Math.round(newestHeartbeatHours);
        return {
            check: createCheck('capture-liveness', TITLE, 'warn', `Hooks have run on this machine (last heartbeat ${lastHeartbeat ?? '?'} hours ago), but not one has left an outcome record. Either the running hooks predate outcome tracking, or they fail as they load and record nothing.`, 'Update the memesh hooks (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), restart your agent, start one session, and re-run `memesh doctor`. If you just updated, start a session first — the records begin on the next hook run.', { code: 'capture-liveness.no-records', params: { hours: lastHeartbeat ?? '?' } }),
            report: { ...report, status: 'PASS_WITH_CONCERNS' },
        };
    }
    if (verdict.stoppedTypes.length > 0) {
        const t = verdict.stoppedTypes[0];
        return {
            check: createCheck('capture-liveness', TITLE, 'warn', `Nothing of type '${t.type}' was captured in the last 7 days, against ${t.prev7} in the 7 days before. Something that was being remembered has stopped being remembered.`, 'Run `memesh doctor --json` for the per-hook figures, and check whether the way you work changed — if it did not, run `memesh install-hooks` and restart your agent.', { code: 'capture-liveness.type-stopped', params: { type: t.type, prev: t.prev7 } }),
            report,
        };
    }
    const writing = hooks.filter((h) => h.writes > 0);
    const ranEnough = hooks.filter((h) => h.triggeredRuns >= SILENT_HOOK_MIN_RUNS);
    let summary;
    if (writing.length > 0) {
        summary = `${writing.length} of ${hooks.length} recording hooks did their work in their recorded window (${writing.map((h) => h.hook).join(', ')}).`;
    }
    else if (ranEnough.length > 0) {
        summary = `${ranEnough.map((h) => `${h.hook} (${h.triggeredRuns} runs)`).join(', ')} ran without writing anything. These hooks decide there is nothing to save on most runs by design, so that is not itself a fault — \`memesh doctor --json\` has the per-hook figures.`;
    }
    else if (hooks.length > 0) {
        summary = `Every recording hook is below the ${SILENT_HOOK_MIN_RUNS}-run threshold where silence would mean anything — too early to say, which is normal on a fresh install.`;
    }
    else {
        summary = 'No hook has recorded an outcome yet — the records start on the next hook run, which is normal right after an upgrade.';
    }
    return {
        check: createCheck('capture-liveness', TITLE, 'pass', summary),
        report,
    };
}
function autoCaptureOffSource() {
    let configAutoCapture;
    try {
        configAutoCapture = readConfig().autoCapture;
    }
    catch {
        configAutoCapture = undefined;
    }
    return autoCaptureDecision(process.env.MEMESH_AUTO_CAPTURE, configAutoCapture).offSource;
}
export function hoursSince(sqliteTimestamp) {
    const then = parseSqliteUtcMs(sqliteTimestamp);
    if (then === null)
        return null;
    return (Date.now() - then) / (60 * 60 * 1000);
}
function formatHoursAgo(hours) {
    if (hours === null || !Number.isFinite(hours) || hours < 0)
        return 'at an unknown time';
    if (hours < 1)
        return 'less than an hour ago';
    if (hours < 48) {
        const h = Math.round(hours);
        return `${h} hour${h === 1 ? '' : 's'} ago`;
    }
    const d = Math.round(hours / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}
function defaultResolveShellMemesh() {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const localRequire = createRequire(import.meta.url);
        const { execFileSync } = localRequire('child_process');
        const out = execFileSync(cmd, ['memesh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        return first || null;
    }
    catch {
        return null;
    }
}
function defaultNativeBindingProbe(_packageRoot) {
    try {
        const probe = new MemeshDatabase(':memory:');
        try {
            probe.prepare('SELECT 1').get();
        }
        finally {
            probe.close();
        }
        return { ok: true };
    }
    catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err), nodeTooOld: isUnsupportedNode(err) };
    }
}
export function satisfiesMinimumNodeRange(version, range) {
    const min = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range.trim());
    const running = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    if (!min || !running)
        return null;
    const wanted = [Number(min[1]), Number(min[2] ?? 0), Number(min[3] ?? 0)];
    const have = [Number(running[1]), Number(running[2]), Number(running[3])];
    for (let i = 0; i < 3; i++) {
        if (have[i] > wanted[i])
            return true;
        if (have[i] < wanted[i])
            return false;
    }
    return true;
}
export function inspectNodeRuntime(packageRoot, existsSyncImpl, readFileSyncImpl, nodeVersion = process.version, moduleAbi = process.versions.modules, hasNodeSqliteImpl = hasBuiltInSqlite) {
    const facts = `Node ${nodeVersion} (ABI ${moduleAbi}, ${process.platform}/${process.arch}). ` +
        `Built-in node:sqlite: ${hasNodeSqliteImpl() ? 'available' : 'not available'}.`;
    let declared;
    try {
        const pkgPath = path.join(packageRoot, 'package.json');
        if (existsSyncImpl(pkgPath)) {
            const parsed = JSON.parse(String(readFileSyncImpl(pkgPath, 'utf8')));
            if (typeof parsed.engines?.node === 'string')
                declared = parsed.engines.node;
        }
    }
    catch {
    }
    if (!declared) {
        return createInfo('node-runtime', 'Node runtime', `${facts} Supported range not checked: package.json declared no engines.node.`);
    }
    const ok = satisfiesMinimumNodeRange(nodeVersion, declared);
    if (ok === null) {
        return createInfo('node-runtime', 'Node runtime', `${facts} Supported range not checked: engines.node is "${declared}", which this ` +
            `check does not parse (it understands ">=X.Y.Z" only).`);
    }
    if (!ok) {
        return createCheck('node-runtime', 'Node runtime', 'fail', `${facts} This package requires Node ${declared}, so this runtime is BELOW the ` +
            `supported floor. Native modules and hooks may fail in ways that look unrelated.`, `Upgrade Node to ${declared.replace(/^>=\s*/, '')} or newer, then run \`memesh doctor\` again.`, { code: 'node-runtime.too-old', params: { detail: facts, required: declared.replace(/^>=\s*/, '') } });
    }
    return createCheck('node-runtime', 'Node runtime', 'pass', `${facts} Meets the required range ${declared}.`);
}
export function hasBuiltInSqlite() {
    try {
        createRequire(import.meta.url).resolve('node:sqlite');
        return true;
    }
    catch {
        return false;
    }
}
function inspectNativeBinding(packageRoot, _existsSyncImpl, probeImpl = defaultNativeBindingProbe) {
    const result = probeImpl(packageRoot);
    if (result.ok)
        return createCheck('native-binding', 'SQLite', 'pass', 'node:sqlite opened a database (probe succeeded).');
    const failed = { code: 'native-binding.load-failed', params: { detail: result.message, root: packageRoot } };
    if (result.nodeTooOld) {
        return createCheck('native-binding', 'SQLite', 'fail', 'SQLite is not usable on this Node version (the Database row above says why).', NODE_TOO_OLD_FIX, failed);
    }
    return createCheck('native-binding', 'SQLite', 'fail', `SQLite could not open a database: ${result.message}`, 'Check the Node runtime and reinstall if necessary.', failed);
}
function readVersionFromInstalledBinary(binaryPath, existsSyncImpl, readFileSyncImpl, realpathSyncImpl = fs.realpathSync) {
    let resolved;
    try {
        resolved = realpathSyncImpl(binaryPath);
    }
    catch {
        resolved = binaryPath;
    }
    let dir = path.dirname(resolved);
    for (let depth = 0; depth < 8; depth += 1) {
        const pkgPath = path.join(dir, 'package.json');
        if (existsSyncImpl(pkgPath)) {
            const parsed = parseJsonFile(pkgPath, readFileSyncImpl);
            if (!parsed.ok)
                return null;
            const { name, version } = parsed.value;
            return name === '@pcircle/memesh' && typeof version === 'string' ? version : null;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
    return null;
}
function inspectShellCli(installChannel, packageRoot, packageVersion, resolveShellMemeshImpl, existsSyncImpl, readFileSyncImpl) {
    const shellPath = resolveShellMemeshImpl();
    const isSameAsCurrent = shellPath ? path.resolve(shellPath).startsWith(path.resolve(packageRoot)) : false;
    const hasDistinctShellCli = !!shellPath && !isSameAsCurrent;
    if (installChannel === 'npm-global') {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
            ? `\`memesh\` resolves to ${shellPath} (npm-global install — terminals across the machine pick it up).`
            : 'Running from npm-global install — shell access available in this terminal.');
    }
    if (hasDistinctShellCli) {
        const shellVersion = readVersionFromInstalledBinary(shellPath, existsSyncImpl, readFileSyncImpl);
        if (shellVersion) {
            return {
                ...createInfo('shell-cli', 'Shell CLI on PATH', `Installed versions: this interface ${packageVersion}; terminal ${shellVersion}.`),
                code: 'shell-cli.versions',
                params: { current: packageVersion, terminal: shellVersion, shellPath: shellPath, packageRoot },
            };
        }
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}) — could not read the shell copy's own version to compare.`);
    }
    if (installChannel === 'plugin-marketplace') {
        const host = detectPluginHost(packageRoot) === 'codex' ? 'Codex CLI' : 'Claude Code';
        return createCheck('shell-cli', 'Shell CLI on PATH', 'warn', 'Plugin is installed but `memesh` is not on the shell PATH. Typing `memesh` in a regular terminal will report `command not found`. '
            + `${host} MCP / hooks / \`/memesh\` skill still work — this only affects standalone shell usage and other MCP clients (Cursor, Cline, etc.).`, 'Run `npm install -g @pcircle/memesh` if you want the separate shell CLI. Its database path depends on its environment and configuration.', { code: 'shell-cli.not-on-path' });
    }
    return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
        ? `\`memesh\` resolves to ${shellPath}.`
        : `No shell-PATH \`memesh\` detected. If you want terminal access, run \`npm install -g @pcircle/memesh\` (this install is a ${installChannel}, so the check is informational only).`);
}
function defaultMarketplaceHeadSha(host) {
    if (host === 'codex') {
        const codexHome = pluginHostConfigRoot('codex');
        return readCodexInstallRevision(path.join(codexHome, '.tmp', 'marketplaces', 'pcircle-memesh'), fs.readFileSync);
    }
    const dir = path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'marketplaces', 'pcircle-memesh');
    try {
        const out = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return /^[0-9a-f]{40}$/.test(out) ? out : null;
    }
    catch {
        return null;
    }
}
function readCodexInstallRevision(root, readFileSyncImpl) {
    const parsed = parseJsonFile(path.join(root, '.codex-marketplace-install.json'), readFileSyncImpl);
    if (!parsed.ok)
        return null;
    const rev = parsed.value.revision;
    return typeof rev === 'string' && /^[0-9a-f]{40}$/.test(rev) ? rev : null;
}
function pluginCacheUnverifiable(host, missing) {
    const hostLabel = host === 'codex' ? 'Codex' : 'Claude Code';
    const command = PLUGIN_REFRESH_COMMANDS[host];
    return createCheck('plugin-cache', `Plugin cache source record is current (${hostLabel})`, 'warn', `Could not tell whether the plugin cache matches the marketplace: ${missing}. The version alone cannot answer this — two builds can carry the same version.`, `Run \`${command}\` — it puts this version back through the same checks an update takes (source check, database backup) and records the commit, after which this check can answer.`, { code: 'plugin-cache.unverifiable', params: { host: hostLabel, command } }, 'plugin-cache-refresh');
}
function readClaudePluginEntries(registryPath, readFileSyncImpl, existsSyncImpl) {
    if (!existsSyncImpl(registryPath)) {
        return { exists: false, readable: false, defined: false, malformed: false, entries: [] };
    }
    const parsed = parseJsonFile(registryPath, readFileSyncImpl);
    if (!parsed.ok)
        return { exists: true, readable: false, defined: false, malformed: false, entries: [] };
    const raw = parsed.value?.plugins?.['memesh@pcircle-memesh'];
    const entries = Array.isArray(raw)
        ? raw.filter((entry) => !!entry && typeof entry === 'object')
        : [];
    return {
        exists: true,
        readable: true,
        defined: raw !== undefined,
        malformed: raw !== undefined && (!Array.isArray(raw) || entries.length !== raw.length),
        entries,
    };
}
function defaultPluginCacheDiscovery(readFileSyncImpl, existsSyncImpl) {
    const discovered = [];
    const claudeConfigRoot = pluginHostConfigRoot('claude-code');
    const claudeRegistry = path.join(claudeConfigRoot, 'plugins', 'installed_plugins.json');
    const claudeCacheRoot = path.join(claudeConfigRoot, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
    const registry = readClaudePluginEntries(claudeRegistry, readFileSyncImpl, existsSyncImpl);
    const entries = registry.entries;
    if (registry.malformed) {
        discovered.push({
            host: 'claude-code',
            packageRoot: claudeCacheRoot,
            installedPluginsPath: claudeRegistry,
            unverifiableReason: 'installed_plugins.json has a malformed memesh entry',
        });
    }
    else if (entries.length > 0) {
        const cachesByRoot = new Map();
        for (const entry of entries) {
            const recordedInstallPath = typeof entry.installPath === 'string' && entry.installPath.length > 0
                ? entry.installPath
                : null;
            const installPath = recordedInstallPath ?? claudeCacheRoot;
            const cache = {
                host: 'claude-code', packageRoot: installPath, installedPluginsPath: claudeRegistry,
                ...(!recordedInstallPath ? { unverifiableReason: 'an installed_plugins.json entry has no usable installPath' }
                    : !existsSyncImpl(installPath) ? { unverifiableReason: `the recorded plugin cache does not exist at ${installPath}` } : {}),
            };
            const rootKey = path.resolve(installPath);
            const existing = cachesByRoot.get(rootKey);
            if (!existing)
                cachesByRoot.set(rootKey, cache);
            else if (!existing.unverifiableReason && cache.unverifiableReason) {
                existing.unverifiableReason = cache.unverifiableReason;
            }
        }
        discovered.push(...cachesByRoot.values());
    }
    else if (registry.defined) {
        const cachedRoots = versionedPluginCacheRoots(claudeCacheRoot);
        if (cachedRoots.length > 0) {
            discovered.push({
                host: 'claude-code',
                packageRoot: cachedRoots[cachedRoots.length - 1],
                installedPluginsPath: claudeRegistry,
                unverifiableReason: 'installed_plugins.json records no active memesh install while a versioned plugin cache still exists',
            });
        }
    }
    else if (!registry.readable) {
        const cachedRoots = versionedPluginCacheRoots(claudeCacheRoot);
        const cachedRoot = cachedRoots[cachedRoots.length - 1];
        if (cachedRoot) {
            discovered.push({
                host: 'claude-code', packageRoot: cachedRoot, installedPluginsPath: claudeRegistry,
                unverifiableReason: registry.exists
                    ? 'installed_plugins.json could not be read or parsed'
                    : 'installed_plugins.json does not exist while a versioned plugin cache still exists',
            });
        }
    }
    const codexHome = pluginHostConfigRoot('codex');
    const codexCacheRoot = path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
    const codexRoots = versionedPluginCacheRoots(codexCacheRoot);
    if (codexRoots.length === 1) {
        discovered.push({ host: 'codex', packageRoot: codexRoots[0] });
    }
    else if (codexRoots.length > 1) {
        discovered.push({
            host: 'codex',
            packageRoot: codexRoots[codexRoots.length - 1],
            unverifiableReason: `several versioned Codex plugin cache directories exist under ${codexCacheRoot}`,
        });
    }
    return discovered;
}
function inspectPluginCacheCurrency(installChannel, pluginHost, packageRoot, installedPluginsPath, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl) {
    if (installChannel !== 'plugin-marketplace')
        return null;
    const host = pluginHost === 'codex' ? 'codex' : 'claude-code';
    const hostLabel = host === 'codex' ? 'Codex' : 'Claude Code';
    const command = PLUGIN_REFRESH_COMMANDS[host];
    let installedSha;
    let installedMissing;
    let recordedVersion = null;
    if (host === 'codex') {
        installedSha = readCodexInstallRevision(packageRoot, readFileSyncImpl);
        installedMissing = 'the plugin cache carries no readable .codex-marketplace-install.json revision';
    }
    else {
        const registryPath = installedPluginsPath ?? path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'installed_plugins.json');
        const registry = readClaudePluginEntries(registryPath, readFileSyncImpl, existsSyncImpl);
        const entries = registry.entries;
        const here = path.resolve(packageRoot);
        const matching = entries.filter(e => typeof e?.installPath === 'string' && path.resolve(e.installPath) === here);
        const soleEntry = entries.length === 1 ? entries[0] : undefined;
        const soleEntryHasPath = typeof soleEntry?.installPath === 'string' && soleEntry.installPath.length > 0;
        const entry = matching.length === 1 ? matching[0] : undefined;
        recordedVersion = typeof entry?.version === 'string' ? entry.version : null;
        installedSha = !registry.malformed
            && typeof entry?.gitCommitSha === 'string'
            && /^[0-9a-f]{40}$/.test(entry.gitCommitSha)
            ? entry.gitCommitSha
            : null;
        if (!registry.exists) {
            installedMissing = `installed_plugins.json does not exist at ${registryPath}`;
        }
        else if (!registry.readable) {
            installedMissing = 'installed_plugins.json could not be read or parsed';
        }
        else if (registry.malformed) {
            installedMissing = 'installed_plugins.json has a malformed memesh entry';
        }
        else if (!registry.defined) {
            installedMissing = 'installed_plugins.json has no memesh@pcircle-memesh entry';
        }
        else if (entries.length === 0) {
            installedMissing = 'installed_plugins.json records no active memesh install for this cache';
        }
        else if (matching.length > 1) {
            installedMissing = `installed_plugins.json lists ${matching.length} memesh entries for this install (${packageRoot})`;
        }
        else if (matching.length === 0 && soleEntryHasPath) {
            installedMissing = `the only memesh entry in installed_plugins.json names another install, not this one (${packageRoot})`;
        }
        else if (matching.length === 0 && soleEntry) {
            installedMissing = 'the only memesh entry in installed_plugins.json has no usable installPath to identify this cache';
        }
        else if (entries.length > 1 && matching.length === 0) {
            installedMissing = `installed_plugins.json lists ${entries.length} memesh entries and none of them is this install (${packageRoot})`;
        }
        else {
            installedMissing = 'installed_plugins.json does not record the commit this plugin was installed from';
        }
    }
    const marketplaceSha = marketplaceHeadShaImpl(host);
    if (!installedSha || !marketplaceSha) {
        const missing = !installedSha ? installedMissing : `the ${hostLabel} marketplace snapshot has no readable commit`;
        return pluginCacheUnverifiable(host, missing);
    }
    if (installedSha === marketplaceSha) {
        return createCheck('plugin-cache', `Plugin cache source record is current (${hostLabel})`, 'pass', `The plugin cache records marketplace commit ${marketplaceSha.slice(0, 8)}, which matches the current marketplace snapshot.`);
    }
    const params = { installed: installedSha.slice(0, 8), marketplace: marketplaceSha.slice(0, 8), host: hostLabel, command };
    let runningVersion = null;
    try {
        runningVersion = JSON.parse(readFileSyncImpl(path.join(packageRoot, 'package.json'), 'utf8')).version ?? null;
    }
    catch { }
    if (recordedVersion !== null && typeof runningVersion === 'string' && recordedVersion !== runningVersion) {
        return createCheck('plugin-cache', `Plugin cache source record is current (${hostLabel})`, 'warn', `${hostLabel}'s record says version ${recordedVersion} is installed from commit ${installedSha.slice(0, 8)}, but the plugin running here is ${runningVersion}: the cache and the record disagree.`, 'Run `memesh update --reinstall`: it puts the verified release back (source check, commit on main, pinned dependencies, read-back) and rewrites the record.', { code: 'plugin-cache.stale', params });
    }
    return createCheck('plugin-cache', `Plugin cache source record is current (${hostLabel})`, 'pass', `The plugin cache records commit ${installedSha.slice(0, 8)}; the ${hostLabel} marketplace has since moved to ${marketplaceSha.slice(0, 8)}. The installed plugin stays on the release MeMesh verified: the marketplace branch is ahead of the last release, and its newer code has not been checked. Nothing to do; \`memesh update\` moves to the next release when one is published.`, undefined, { code: 'plugin-cache.behind-marketplace', params });
}
function isClaudeChannelCommand(command) {
    if (command === 'memesh-host-claude')
        return true;
    if (typeof command !== 'string' || !path.isAbsolute(command) || path.basename(command) !== 'memesh-host-claude') {
        return false;
    }
    try {
        const target = fs.realpathSync(command);
        const stat = fs.statSync(target);
        if (!stat.isFile())
            return false;
        fs.accessSync(target, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function inspectClaudeChannelRegistration(existsSyncImpl, readFileSyncImpl) {
    const configPath = path.join(homeDir(), '.claude.json');
    let parsed = null;
    if (existsSyncImpl(configPath)) {
        try {
            const value = JSON.parse(readFileSyncImpl(configPath, 'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('not an object');
            parsed = value;
        }
        catch {
            return createCheck('claude-channel', 'Claude Channel registration', 'warn', 'The canonical Claude user config could not be read as JSON, so the memesh-channel registration is malformed or unverifiable.', 'Repair the owner-controlled Claude config with `claude mcp remove memesh-channel` and re-run `memesh agent setup claude` to obtain a fresh registration command.');
        }
    }
    const servers = parsed?.mcpServers;
    const server = servers && typeof servers === 'object' && !Array.isArray(servers)
        ? servers['memesh-channel']
        : undefined;
    if (server === undefined) {
        return createCheck('claude-channel', 'Claude Channel registration', 'warn', 'No user-scoped memesh-channel registration was found. Durable MCP/inbox messaging can still work, but live Claude Channel notification is inactive. The upstream research-preview channel remains opt-in.', 'If you want the opt-in channel, run `memesh agent setup claude` and then register the printed user-scoped MCP command.', { code: 'claude-channel.unregistered' });
    }
    const record = server && typeof server === 'object' && !Array.isArray(server)
        ? server
        : null;
    const command = record?.command;
    const rawArgs = record?.args;
    const args = Array.isArray(rawArgs) ? rawArgs : null;
    const configIndex = args?.indexOf('--config') ?? -1;
    const target = args && configIndex >= 0 && typeof args[configIndex + 1] === 'string'
        ? args[configIndex + 1]
        : null;
    let targetConfigValid = false;
    if (target) {
        try {
            const config = readHostConfigFile(target);
            const required = ['router_socket', 'token_file', 'principal_id'];
            targetConfigValid = config.server_name === 'memesh-channel'
                && required.every((key) => {
                    const value = config[key];
                    return typeof value === 'string'
                        && value.length > 0
                        && Buffer.byteLength(value) <= 4096;
                });
        }
        catch {
            targetConfigValid = false;
        }
    }
    const commandValid = isClaudeChannelCommand(command);
    const coherent = commandValid
        && args !== null
        && args.length === 2
        && configIndex === 0
        && target !== null
        && targetConfigValid;
    if (!coherent) {
        const reason = !commandValid || args === null || configIndex !== 0 || target === null
            ? 'the command or --config declaration is malformed'
            : 'the declared owner config target is missing, insecure, malformed, or incomplete';
        return createCheck('claude-channel', 'Claude Channel registration', 'warn', `The user-scoped memesh-channel registration is present but ${reason}. Live Claude Channel notification is not established.`, 'Remove and re-register the owner-controlled memesh-channel entry with `memesh agent setup claude`; keep its generated config file owner-private.');
    }
    return createInfo('claude-channel', 'Claude Channel registration', 'The user-scoped memesh-channel registration and owner-private config target are coherent (CONFIGURED). Development-channel admission and agent surfacing are not verified; durable MCP/inbox messaging remains a separate path.');
}
function isFreshInstall(packageRoot, statSyncImpl) {
    const HOUR_MS = 60 * 60 * 1000;
    try {
        const record = readInstallRecordState();
        if (record.status === 'ok') {
            if (record.created_at === null)
                return false;
            const ageHours = (Date.now() - new Date(record.created_at).getTime()) / HOUR_MS;
            return ageHours >= 0 && ageHours < 24;
        }
        if (record.status === 'unreadable')
            return false;
        const stat = statSyncImpl(path.join(packageRoot, 'package.json'));
        const installedAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
        if (!Number.isFinite(installedAt) || installedAt <= 0)
            return false;
        const ageHours = (Date.now() - installedAt) / HOUR_MS;
        return ageHours >= 0 && ageHours < 24;
    }
    catch {
        return false;
    }
}
function inspectAutoUpdate(installSupport) {
    const policy = currentPolicy();
    const cannotSelfUpdate = installSupport !== undefined && !installSupport.canSelfUpdate;
    const setting = policy.policy === 'off'
        ? `off (${policy.reason ?? 'policy is off'})`
        : cannotSelfUpdate
            ? `on in the settings, but this install (${installSupport.label}) cannot update itself, so nothing is installed. ${installSupport.guidance}`
            : `on for ${policy.policy === 'major' ? 'every version' : `${policy.policy} versions and below`}; it installs after running sessions end (waiting at most 3 days, after which sessions still open may use the new files before they restart)`;
    const dataDir = getMemeshDirFromDbPath();
    const read = inspectAutoUpdateState(dataDir);
    const installing = readInstalling(dataDir);
    if (installing && !installing.running) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. An update from ${installing.marker.from} to ${installing.marker.to} began its install at ${installing.marker.at}, and the process that ran it is gone without recording a result, so the install may be half done.`, `Put this version back through the same checks with \`memesh update --reinstall\` (a database backup was made before the install began: see ${path.join(dataDir, 'backups')}). Details: ${path.join(dataDir, 'auto-update.log')}.`, { code: 'auto-update.interrupted' });
    }
    const holder = describeLockHolder(dataDir);
    if (holder && !holder.running) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. The update lock was left behind by a ${holder.label === 'manual' ? 'manual' : 'automatic'} update (pid ${holder.pid}, started ${holder.startedAt}) that is no longer running.`, `Nothing to do: the next update attempt takes the lock over about 2 minutes after its owner is found gone. Details: ${path.join(dataDir, 'auto-update.log')}.`, { code: 'auto-update.lock-orphan' });
    }
    const running = installing?.running ? ` An install to ${installing.marker.to} is running now (since ${installing.marker.at}).` : holder?.running ? ` An update is running now (started ${holder.startedAt}, ${holder.label === 'manual' ? 'by hand' : 'automatic'}).` : '';
    if (read.kind === 'unreadable') {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. The record of the last attempt cannot be read (${read.detail}), so it is not known whether one ran or failed.`, `Look at ${path.join(dataDir, 'auto-update-state.json')} and ${path.join(dataDir, 'auto-update.log')}; removing the damaged record (a file, or a directory that is in its place) is safe: the next attempt writes a new one.`, { code: 'auto-update.state-unreadable' });
    }
    if (read.kind === 'absent') {
        return createCheck('auto-update', 'Automatic updates', 'pass', `Automatic updates are ${setting}. No attempt has run yet.${running}`);
    }
    const state = read.state;
    const waitedDays = state.outcome === 'waiting' && state.waitingSince ? Math.floor((Date.now() - Date.parse(state.waitingSince)) / 86_400_000) : null;
    const hermesResults = Array.isArray(state.hermes) ? state.hermes : [];
    const hermesNotes = hermesResults.map((h) => ` Hermes provider at ${h.path}: ${h.outcome} — ${h.reason}.`).join('');
    const what = `Last attempt ${state.at}: ${state.outcome} — ${state.reason}${state.to ? ` (${state.from ?? '?'} → ${state.to})` : ''}${waitedDays !== null && waitedDays >= 0 ? `; waiting for ${waitedDays} day(s) of the 3 allowed` : ''}.${hermesNotes}${state.notice ? ` Note: ${state.notice}.` : ''}${running}`;
    const logPath = path.join(dataDir, 'auto-update.log');
    const hermesAdvice = `To put the Hermes provider in place by hand: \`memesh hermes install\` (add \`--path <dir>\` for a copy outside the default place; a directory MeMesh did not install is only replaced with \`--force\`, and is saved first). Read ${logPath} for the reason.`;
    if (waitedDays !== null && waitedDays >= 3) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, `The wait for running sessions is limited to 3 days, so the update should have installed by now: its runner is probably not running. Update now with \`${installSupport?.recommendedCommand ?? 'memesh update'}\` (it does not wait for sessions); read ${logPath} for what the runner said.`, { code: 'auto-update.wait-overdue' });
    }
    if (state.reason === AUTO_UPDATE_REASONS.installedAfterWait) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, `Restart the sessions that were open during the update so they run the new version together with their hooks.${hermesResults.some((h) => h.outcome === 'failed') ? ` ${hermesAdvice}` : ''}`, { code: 'auto-update.mixed-versions' });
    }
    if (hermesResults.some((h) => h.outcome === 'failed')) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, hermesAdvice, { code: 'auto-update.hermes-failed' });
    }
    if (state.reason === AUTO_UPDATE_REASONS.codexMarketplaceMissing) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, 'The Codex marketplace pcircle-memesh is not in config.toml, and MeMesh did not remove it, so it is taken as removed on purpose and the Codex plugin is not being updated. If that was on purpose, nothing to do. To get it back, pinned to the verified release: `memesh update --reinstall`.', { code: 'auto-update.codex-marketplace-missing' });
    }
    if (state.reason === AUTO_UPDATE_REASONS.codexRestoreFailed) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, 'An update removed the Codex marketplace pcircle-memesh and then failed before it could put it back: it is missing because of that update, not because you removed it. The next automatic run puts it back while config.toml is unchanged; to do it now: `codex plugin marketplace add PCIRCLE-AI/memesh`, then `memesh update --reinstall`.', { code: 'auto-update.codex-restore-failed' });
    }
    if (state.reason === AUTO_UPDATE_REASONS.dependencyPinFailed) {
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, `The update was undone and ${state.from ?? 'the previous version'} is still what runs: nothing is broken. The next automatic run, or \`memesh update\`, tries again. If it keeps failing, read ${path.join(getMemeshDirFromDbPath(), 'auto-update.log')} for the step that failed (usually the network or the registry).`, { code: 'auto-update.pin-undone' });
    }
    if (state.outcome === 'failed') {
        const log = path.join(getMemeshDirFromDbPath(), 'auto-update.log');
        const backup = state.backup ? ` A database backup was made first: ${state.backup}` : '';
        const sourceRejected = state.reason === AUTO_UPDATE_REASONS.sourceNotVerified || state.reason === AUTO_UPDATE_REASONS.tarballMismatch || state.reason === AUTO_UPDATE_REASONS.commitNotOnMain || state.reason === AUTO_UPDATE_REASONS.dependenciesNotPinned;
        const fix = state.reason === AUTO_UPDATE_REASONS.installNotUndone
            ? `Run \`memesh update --reinstall\`: it puts this version back through the same checks and finishes the install. Until then MeMesh may not start (its dependencies are missing). Read ${log} for what happened.${backup}`
            : sourceRejected
                ? `Do not install this version by other means (${installSupport?.channel === 'npm-global' || installSupport === undefined ? 'a bare npm install' : 'installing it from the marketplace yourself'}): that skips the check of where the package came from. \`memesh update\` runs the same check and will refuse too. Read ${log} for the check that failed; if it keeps failing, report it.${backup}`
                : installSupport?.recommendedCommand
                    ? `Read ${log} for the step that failed, then update by hand with \`${installSupport.recommendedCommand}\`.${backup}`
                    : `Read ${log} for the step that failed, then update the way you installed MeMesh.${backup}`;
        return createCheck('auto-update', 'Automatic updates', 'warn', `Automatic updates are ${setting}. ${what}`, fix, { code: 'auto-update.failed' });
    }
    return createCheck('auto-update', 'Automatic updates', 'pass', `Automatic updates are ${setting}. ${what}`);
}
async function inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport, packageRoot, statSyncImpl) {
    const update = await getUpdateCheckImpl(packageVersion, { preferFresh: false });
    if (!update) {
        if (isFreshInstall(packageRoot, statSyncImpl)) {
            return createCheck('update-status', 'Update status', 'pass', 'Installed recently — memesh has not had a chance to check for updates yet. This resolves itself on the first successful check.');
        }
        return createCheck('update-status', 'Update status', 'warn', 'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.', 'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.', { code: 'update-status.no-cache' });
    }
    if (update.currentVersionDeprecated && update.deprecationMessage) {
        const target = update.latestVersion && update.latestVersion !== packageVersion
            ? ` -> ${update.latestVersion}`
            : '';
        const hasUpgradeTarget = update.latestVersion
            && update.latestVersion !== packageVersion;
        let fix;
        if (installSupport?.canSelfUpdate) {
            fix = hasUpgradeTarget
                ? `Run \`memesh update\`${target}.`
                : 'Run `memesh update` to refresh the registry lookup and apply any newly-published fix.';
        }
        else if (installSupport?.guidance) {
            fix = installSupport.guidance + (hasUpgradeTarget
                ? ` Upgrade target: ${update.latestVersion}.`
                : ' Upgrade target uncertain — re-check `memesh status` while online.');
        }
        else {
            fix = `Upgrade via your install method (see \`memesh status\`).`;
        }
        return createCheck('update-status', 'Update status', 'fail', `Installed version ${packageVersion} is DEPRECATED by maintainers: ${update.deprecationMessage}`, fix, { code: 'update-status.deprecated', params: { version: packageVersion, detail: update.deprecationMessage ?? '' } });
    }
    if (update.freshness === 'unavailable') {
        if (isFreshInstall(packageRoot, statSyncImpl) && !update.lastAttemptAt && !update.lastError) {
            return createCheck('update-status', 'Update status', 'pass', 'Installed recently — memesh has not had a chance to check for updates yet. This resolves itself on the first successful check.');
        }
        return createCheck('update-status', 'Update status', 'warn', 'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.', 'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.', { code: 'update-status.no-cache' });
    }
    if (update.checkSucceeded && update.lastError) {
        const hasUpdate = Boolean(update.updateAvailable && update.latestVersion);
        const summary = hasUpdate
            ? `Deprecation status unknown for ${packageVersion}: ${withoutFinalPeriod(update.lastError)}. Update ${update.latestVersion} is available.`
            : `Deprecation status unknown for ${packageVersion}: ${withoutFinalPeriod(update.lastError)}.`;
        let upgradeHint;
        if (hasUpdate) {
            if (installSupport?.canSelfUpdate) {
                upgradeHint = `, or \`memesh update\` to apply ${update.latestVersion}`;
            }
            else if (installSupport?.guidance) {
                upgradeHint = `. Upgrade target ${update.latestVersion} via your install method: ${installSupport.guidance}`;
            }
            else {
                upgradeHint = `. Upgrade target: ${update.latestVersion}.`;
            }
        }
        else {
            upgradeHint = '';
        }
        const fix = `Run \`memesh status\` while online to retry the deprecation lookup${upgradeHint}.`;
        return createCheck('update-status', 'Update status', 'warn', summary, fix, {
            code: 'update-status.deprecation-unknown',
            params: { version: packageVersion, detail: update.lastError ?? '' },
        });
    }
    if (update.latestVersion && update.latestVersion !== packageVersion) {
        if (classifyBump(packageVersion, update.latestVersion)) {
            return createCheck('update-status', 'Update status', 'warn', `Update available: ${update.latestVersion} (current: ${packageVersion})`, `Run 'memesh update' to upgrade`, { code: 'update-status.update-available', params: { latest: update.latestVersion, current: packageVersion } });
        }
        else {
            return createCheck('update-status', 'Update status', 'pass', `Running pre-release version (${packageVersion}), npm latest is ${update.latestVersion}`);
        }
    }
    const checkedHoursAgo = update.lastSuccessfulCheckAt === null
        ? null
        : (Date.now() - Date.parse(update.lastSuccessfulCheckAt)) / 3600_000;
    const checkedAgo = formatHoursAgo(checkedHoursAgo);
    return createCheck('update-status', 'Update status', update.freshness === 'stale' ? 'warn' : 'pass', update.freshness === 'stale'
        ? `As of the last check (${checkedAgo}), ${packageVersion} was the latest version — that check is more than 24h old, so a newer release may exist since. Doctor never makes a live registry call itself.`
        : `As of the last check (${checkedAgo}), ${packageVersion} was the latest version.`, update.freshness === 'stale'
        ? 'Run `memesh status` while online to refresh cached update metadata.'
        : undefined, update.freshness === 'stale'
        ? { code: 'update-status.stale', params: { version: packageVersion } }
        : undefined);
}
async function inspectHttpProbe(httpBaseUrl, fetchImpl) {
    try {
        const response = await fetchImpl(`${httpBaseUrl.replace(/\/$/, '')}/v1/health`);
        if (!response.ok) {
            return createCheck('http-probe', 'HTTP probe', 'warn', `HTTP server responded with ${response.status} at ${httpBaseUrl}.`, 'Run `memesh serve` and check the logs, then retry `memesh doctor --probe-http`.', { code: 'http-probe.bad-status', params: { status: response.status, url: httpBaseUrl } });
        }
        return createCheck('http-probe', 'HTTP probe', 'pass', `HTTP server is reachable at ${httpBaseUrl}.`);
    }
    catch {
        return createCheck('http-probe', 'HTTP probe', 'warn', `No running HTTP server detected at ${httpBaseUrl}.`, 'Start the local server with `memesh serve` if you want HTTP API verification.', { code: 'http-probe.no-server', params: { url: httpBaseUrl } });
    }
}
function verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl, installSupport) {
    const reinstall = installSupport.guidance;
    const manifestPath = path.join(packageRoot, 'dist', 'skills-manifest.json');
    if (!existsSyncImpl(manifestPath)) {
        if (installSupport.channel === 'source-checkout') {
            return createCheck('skills-manifest', 'Skills + hooks integrity', 'warn', 'No skills-manifest.json found. This is normal for source checkouts — packaged installs ship the manifest.', `Run \`npm run build\` to regenerate.`, { code: 'skills-manifest.missing-dev' });
        }
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', 'No skills-manifest.json found, and this is not a source checkout: a packaged install always ships it. A file was removed from this install, so the skill and hook files cannot be verified.', `Reinstall the package: ${reinstall} If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh/security.`, { code: 'skills-manifest.missing' });
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSyncImpl(manifestPath, 'utf8'));
    }
    catch (err) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `skills-manifest.json is unreadable (${err instanceof Error ? err.message : 'parse error'}).`, `Reinstall the package: ${reinstall} If the problem persists open an issue.`, { code: 'skills-manifest.unreadable', params: { detail: err instanceof Error ? err.message : 'parse error' } });
    }
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    if (entries.length === 0) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', 'skills-manifest.json contains zero entries.', `Reinstall the package: ${reinstall}`, { code: 'skills-manifest.empty' });
    }
    const mismatches = [];
    const missing = [];
    for (const entry of entries) {
        const full = path.join(packageRoot, entry.path);
        if (!existsSyncImpl(full)) {
            missing.push(entry.path);
            continue;
        }
        try {
            const kind = fs.lstatSync(full);
            if (!kind.isFile() && !kind.isSymbolicLink()) {
                mismatches.push(`${entry.path} (not a regular file)`);
                continue;
            }
        }
        catch { }
        let actualHash;
        try {
            const buf = readFileSyncImpl(full);
            actualHash = createHash('sha256').update(buf).digest('hex');
        }
        catch (err) {
            mismatches.push(`${entry.path} (read error: ${err instanceof Error ? err.message : 'unknown'})`);
            continue;
        }
        if (actualHash !== entry.sha256)
            mismatches.push(entry.path);
    }
    const listed = new Set(entries.map((entry) => entry.path));
    const scope = manifestScope(packageRoot);
    const unlisted = scope.files.filter((file) => !listed.has(file));
    const unaccounted = [
        ...scope.missingRequired.map((p) => `${p} (required, not found)`),
        ...scope.symlinks.map((p) => `${p} (symbolic link)`),
        ...scope.unreadable.map((p) => `${p} (cannot be read)`),
        ...scope.strayFolders.map((p) => `${p} (a folder npm pack never ships)`),
        ...scope.special.map((p) => `${p} (not a file)`),
    ];
    if (missing.length === 0 && mismatches.length === 0 && unlisted.length === 0 && unaccounted.length === 0) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'pass', `${entries.length} skill / hook files match the published manifest (SHA-256 verified); ${scope.files.length} files are in the covered scope on disk, none unlisted.`);
    }
    const detail = [
        unaccounted.length > 0 ? `${unaccounted.length} not accounted for: ${unaccounted.slice(0, 3).join(', ')}${unaccounted.length > 3 ? ` (+${unaccounted.length - 3} more)` : ''}` : null,
        unlisted.length > 0 ? `${unlisted.length} not in the manifest: ${unlisted.slice(0, 3).join(', ')}${unlisted.length > 3 ? ` (+${unlisted.length - 3} more)` : ''}` : null,
        missing.length > 0 ? `${missing.length} missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}` : null,
        mismatches.length > 0 ? `${mismatches.length} tampered: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? ` (+${mismatches.length - 3} more)` : ''}` : null,
    ].filter(Boolean).join('; ');
    return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `Manifest verification failed: ${detail}.`, `Reinstall the package: ${reinstall} If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh/security.`, { code: 'skills-manifest.verify-failed', params: { detail } });
}
function probeInstalledMessageCapability(packageRoot) {
    const required = [
        'dist/transports/cli/doctor-message-probe.js',
        'dist/mcp/server.js',
        'dist/transports/mcp/handlers.js',
        'dist/host-adapters/codex-app-server.js',
        'dist/host-adapters/claude-channel.js',
        'dist/host-adapters/acp-client.js',
    ];
    const absent = required.filter((relative) => !fs.existsSync(path.join(packageRoot, relative)));
    if (absent.length > 0)
        return { ok: false, message: `installed runtime is missing ${absent.join(', ')}` };
    const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-message-'));
    try {
        execFileSync(process.execPath, [path.join(packageRoot, 'dist/transports/cli/doctor-message-probe.js'), packageRoot], {
            cwd: packageRoot,
            stdio: 'pipe',
            timeout: 15_000,
            env: { ...process.env, HOME: probeHome, MEMESH_AUTO_CAPTURE: 'false' },
        });
        return { ok: true };
    }
    catch {
        return { ok: false, message: 'installed MCP or bundled host adapters did not complete the message capability probe' };
    }
    finally {
        fs.rmSync(probeHome, { recursive: true, force: true });
    }
}
function inspectMessageCapability(packageRoot, enabled, probe) {
    if (!enabled) {
        return createInfo('message-capability', 'Message adapter imports', 'Not verified (opt-in). Set MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 to start this installed MCP and verify its ten-action message schema plus bundled host-adapter imports. This does not check a live router socket or host registration.');
    }
    const result = probe(packageRoot);
    if (result.ok)
        return createCheck('message-capability', 'Message adapter imports', 'pass', 'This installed MCP advertised the ten-action message schema and all bundled host adapters imported successfully. No live router socket, host registration, or host acceptance was verified.');
    return createCheck('message-capability', 'Message adapter imports', 'fail', `Installed message capability probe failed: ${withoutFinalPeriod(result.message)}.`, 'Reinstall or rebuild this package, then retry with MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1.', { code: 'message-capability.probe-failed', params: { detail: result.message } });
}
function inspectInstallJourney(packageVersion) {
    const record = readJourneyRecord();
    if (record === undefined) {
        return createInfo('install-journey', 'Install journey', 'No install journey recorded yet. It runs after `memesh install-hooks` and `memesh setup`; run it now with `memesh doctor --journey`.');
    }
    if ('unreadable' in record) {
        return createCheck('install-journey', 'Install journey', 'warn', `The saved journey result could not be read: ${record.unreadable}.`, `Delete ${journeyRecordPath()}, or re-run \`memesh install-hooks\` or \`memesh setup\`, which write a new one.`, { code: 'install-journey.unreadable', params: { detail: record.unreadable } });
    }
    const stale = record.version !== packageVersion ? ` This result is from v${record.version}; this is v${packageVersion}.` : '';
    if (record.ok) {
        if (record.version !== packageVersion) {
            return createInfo('install-journey', 'Install journey', `The last journey passed on v${record.version} (${record.at}); this is v${packageVersion}. Run \`memesh doctor --journey\` to check this version.`);
        }
        return createCheck('install-journey', 'Install journey', 'pass', `Store, search, send and read back worked at ${record.at} (v${record.version}).`);
    }
    if (record.failedStep === 'prepare') {
        return createCheck('install-journey', 'Install journey', 'warn', `The journey could not run at ${record.at}: ${record.reason}. memesh itself was not checked.${stale}`, record.fix ?? 'Run `memesh doctor --journey`.', { code: 'install-journey.not-run', params: { detail: record.reason ?? '' } });
    }
    return createCheck('install-journey', 'Install journey', 'warn', `The journey failed at "${record.failedStep}" at ${record.at}: ${record.reason}.${stale}`, record.fix ?? 'Run `memesh doctor --journey`.', { code: 'install-journey.failed', params: { step: record.failedStep ?? 'unknown', detail: record.reason ?? '' } });
}
async function defaultMessageRouterStatusProbe() {
    const socketPath = process.env.MEMESH_ROUTER_SOCKET ?? getAgentRouterSocketPath();
    const socketPathBytes = Buffer.byteLength(socketPath);
    if (socketPathBytes > AGENT_ROUTER_SOCKET_PATH_MAX_BYTES) {
        return { socket_path: socketPath, socket: 'path-too-long', detail: `${socketPathBytes} bytes` };
    }
    let stat;
    try {
        stat = fs.lstatSync(socketPath);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { socket_path: socketPath, socket: 'missing', detail };
    }
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
        return { socket_path: socketPath, socket: 'insecure' };
    }
    const reachable = await new Promise((resolve) => {
        const socket = net.createConnection({ path: socketPath });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, 1_500);
        timer.unref();
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
    return { socket_path: socketPath, socket: reachable ? 'reachable' : 'unreachable' };
}
async function inspectMessageRouterStatus(enabled, probe, lastIdleExit) {
    if (!enabled) {
        return createInfo('message-router-status', 'Live message router / host registration', 'Not verified (opt-in). Set MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 to check only whether the owner-private Local router socket is live. This check never starts a router, registers a host, sends a message, or wakes a stopped session.');
    }
    const result = await probe();
    switch (result.socket) {
        case 'reachable':
            return createCheck('message-router-status', 'Live message router / host registration', 'pass', `Owner-private Local router socket is reachable at ${result.socket_path}. This proves only router availability; it does not prove an active host registration, native delivery, host_accept, ACK, or stopped-session wake-up.`);
        case 'missing':
            return createCheck('message-router-status', 'Live message router / host registration', 'warn', `No Local router socket exists at ${result.socket_path}. No active host is registered through this router, and MeMesh will not wake a stopped or missing session.${lastIdleExit ? ` The router last ended itself for idleness at ${lastIdleExit}.` : ' No idle exit of the router is recorded, so if a session was open a moment ago the router may have stopped for another reason.'}`, 'The router ends itself after 10 minutes (MEMESH_ROUTER_IDLE_MS) with no host connected and nothing being delivered, so a missing socket is normal while no session is open; a host session or a message send starts it again. To check it now, start a session or the owner-configured router with `memesh-router`, then run this opt-in probe again.', { code: 'message-router.socket-missing', params: { path: result.socket_path } });
        case 'path-too-long':
            return createCheck('message-router-status', 'Live message router / host registration', 'fail', `The router socket path is ${result.detail} — over the ${AGENT_ROUTER_SOCKET_PATH_MAX_BYTES}-byte limit a Unix domain socket allows, so \`memesh-router\` cannot create it at ${result.socket_path}. Starting the router again fails the same way.`, process.env.MEMESH_ROUTER_SOCKET !== undefined
                ? 'Set MEMESH_ROUTER_SOCKET to a shorter absolute path in a folder only you can access (owner-private), then start `memesh-router` again. It reaches `memesh-router`, `memesh doctor`, senders and ordinary Claude MCP sessions. Host configs written by `memesh agent setup` (`hosts/codex-session.json` included) keep the default path, and ordinary Codex sessions use the default path, so shorten HOME / MEMESH_DIR instead if they must reach this router.'
                : 'Move HOME / MEMESH_DIR somewhere with a shorter path, then start `memesh-router` again. With MEMESH_DB_PATH set, the default socket sits in that database\'s folder, so move the database; the socket\'s folder must be owner-private. Setting MEMESH_ROUTER_SOCKET alone is not enough: it does not reach host configs written by `memesh agent setup` (`hosts/codex-session.json` included) or ordinary Codex sessions, which use the default path.', { code: 'message-router.socket-path-too-long', params: { path: result.socket_path, bytes: result.detail ?? 'unknown' } });
        case 'insecure':
            return createCheck('message-router-status', 'Live message router / host registration', 'fail', `Router socket at ${result.socket_path} is not an owner-private Unix socket.`, 'Stop the router, remove the unsafe socket, and restart `memesh-router` under the owning user.', { code: 'message-router.socket-insecure', params: { path: result.socket_path } });
        case 'unreachable':
            return createCheck('message-router-status', 'Live message router / host registration', 'warn', `An owner-private router socket exists at ${result.socket_path}, but it did not accept a local connection. No host registration or native delivery is verified.`, 'Check the owner-configured `memesh-router` process, then run this opt-in probe again.', { code: 'message-router.socket-unreachable', params: { path: result.socket_path } });
    }
}
function summarizeOverallStatus(checks) {
    const assertions = checks.filter((check) => !check.informational);
    if (assertions.some((check) => check.status === 'fail'))
        return 'FAIL';
    if (assertions.some((check) => check.status === 'warn'))
        return 'PASS_WITH_CONCERNS';
    return 'PASS';
}
export async function runDoctor(options) {
    const { packageRoot, packageVersion, probeHttp = false, httpBaseUrl = 'http://127.0.0.1:3737', platform = process.platform, envImpl = process.env, openDatabaseImpl = openDatabaseForDoctor, closeDatabaseImpl = closeDatabase, isDatabaseOpenImpl = isDatabaseOpen, getConfigPathImpl = getConfigPath, getUpdateCheckImpl = getUpdateCheck, getCurrentInstallChannelImpl = getCurrentInstallChannel, installedPluginsPathImpl, marketplaceHeadShaImpl = defaultMarketplaceHeadSha, pluginCacheDiscoveryImpl, getInstallChannelSupportImpl = getInstallChannelSupport, existsSyncImpl = fs.existsSync, readFileSyncImpl = fs.readFileSync, statSyncImpl = fs.statSync, fetchImpl = fetch, agentMessageStoragePolicy, nativeBindingProbeImpl, resolveShellMemeshImpl = defaultResolveShellMemesh, probeMessageCapability = process.env.MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY === '1', messageCapabilityProbeImpl = probeInstalledMessageCapability, probeMessageRouterStatus = process.env.MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER === '1', messageRouterStatusProbeImpl = defaultMessageRouterStatusProbe, } = options;
    const wasDbOpenBeforeUs = isDatabaseOpenImpl();
    const safeCloseDatabaseImpl = wasDbOpenBeforeUs
        ? () => undefined
        : closeDatabaseImpl;
    const checks = [];
    const install = getCurrentInstallChannelImpl({ packageRoot });
    const installSupport = getInstallChannelSupportImpl(install, packageRoot);
    checks.push(createCheck('install-channel', 'Install method', install === 'unknown' ? 'warn' : 'pass', `Install method detected: ${installSupport.label}.`, install === 'unknown'
        ? 'If this is a source checkout, run MeMesh from the repo root. If this is a packaged install, reinstall with `npm install -g @pcircle/memesh`.'
        : undefined, install === 'unknown' ? { code: 'install-channel.unknown' } : undefined));
    const databasePath = resolveDatabasePath();
    const dbChecks = [];
    let lastRouterIdleExit;
    try {
        const db = openDatabaseImpl(databasePath);
        const integrity = quickIntegrityVerdict(db);
        if (integrity !== 'ok') {
            throw Object.assign(new Error(`Database at ${databasePath} opened, but SQLite's quick integrity check failed: ${integrity}`), {
                fix: damagedDatabaseFix(databasePath),
            });
        }
        try {
            unreadDeliveryCount(db, '', 'memesh-doctor');
        }
        catch (err) {
            const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
            throw Object.assign(new Error(`Database at ${databasePath} opened, but its message inbox cannot be read: ${reason}`), {
                fix: 'This memesh cannot read the message tables, and briefing says the same. If a newer memesh version also uses this database, update this one to match it; otherwise the tables were changed outside memesh: restore a backup you trust, or report the error quoted above.',
            });
        }
        try {
            lastRouterIdleExit = readRouterIdleExit(db);
        }
        catch {
            lastRouterIdleExit = undefined;
        }
        const count = db.prepare('SELECT COUNT(*) as c FROM entities').get()?.c ?? 0;
        const writeBack = ownerWriteCommand(databasePath);
        const folder = readOnlyFolderState();
        dbChecks.push(folder
            ? createCheck('database', 'Database', 'warn', `Database at ${databasePath} (${count} entities) is open for reads only: ${folder.reason}.`, runOrSay(folder.fix))
            : writeBack
                ? createCheck('database', 'Database', 'warn', `Database at ${databasePath} (${count} entities) is read-only: reads work, writes are refused.`, `If it should be writable, ${writeBack}`)
                : createCheck('database', 'Database', 'pass', `Database opened successfully at ${databasePath} (${count} entities).`));
        const messageStorage = inspectAgentMessageStorage(db, databasePath, configuredAgentMessageStoragePolicy(agentMessageStoragePolicy));
        if (messageStorage)
            dbChecks.push(messageStorage);
        const messageExpiry = inspectAgentMessageExpiry(db);
        if (messageExpiry)
            dbChecks.push(messageExpiry);
        const codexQueueDaemon = inspectCodexQueueDaemon(db);
        if (codexQueueDaemon)
            dbChecks.push(codexQueueDaemon);
        const heldNotices = inspectHeldNotices(db);
        if (heldNotices)
            dbChecks.push(heldNotices);
        const unreadableTranscripts = inspectUnreadableTranscripts(db);
        if (unreadableTranscripts)
            dbChecks.push(unreadableTranscripts);
        const projectSplit = inspectProjectIdentitySplit(db);
        if (projectSplit)
            dbChecks.push(projectSplit);
        const hasVocab = db
            .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'fts_vocab'`)
            .get();
        if (hasVocab?.present) {
            const unsegmented = db
                .prepare(`SELECT COUNT(*) AS c FROM fts_vocab
            WHERE length(term) > 2
              AND term GLOB ?`)
                .get(UNSPACED_SCRIPT_GLOB_RUN3);
            if (unsegmented?.c) {
                dbChecks.push(createCheck('fts_segmentation', 'Keyword index segmentation', 'warn', `The keyword index holds ${unsegmented.c} unsegmented term(s), so some memories are only ` +
                    `findable by their exact full text. This happens when an older build wrote to a database ` +
                    `that a newer one had already migrated — the version marker only moves forward, so the ` +
                    `automatic rebuild cannot notice. Re-run doctor after the rebuild: this count should be 0.`, `Run 'memesh reindex --fts' to rebuild the keyword index.`, { code: 'fts.unsegmented', params: { count: unsegmented.c } }, 'fts-rebuild'));
            }
        }
        try {
            const guardRows = db
                .prepare(`SELECT id, name, metadata FROM entities
           WHERE status = 'active'
             AND type IN ('lesson_learned', 'lesson', 'mistake')
             AND metadata LIKE '%"guard"%'`)
                .all();
            const fired = guardRows
                .filter((r) => guardFromMetadata(r.id, r.metadata) !== null)
                .map((r) => {
                let fires = 0;
                try {
                    const parsedMeta = JSON.parse(r.metadata);
                    if (typeof parsedMeta.guard?.fires === 'number')
                        fires = parsedMeta.guard.fires;
                }
                catch { }
                return { name: r.name, fires };
            })
                .sort((a, b) => b.fires - a.fires);
            if (fired.length > 0) {
                const everFired = fired.filter((g) => g.fires > 0);
                const top = everFired.slice(0, 3).map((g) => `${g.name} (${g.fires})`).join(', ');
                dbChecks.push(createInfo('guard_activity', 'Guard activity', `${fired.length} active guard(s); ${everFired.length} have ever fired`
                    + (top ? `. Most: ${top}.` : '. None has matched yet.')));
            }
        }
        catch {
        }
        const citationTotalRow = db
            .prepare(`SELECT value FROM memesh_metadata WHERE key = 'citation_sessions_total'`)
            .get();
        const citedRow = db
            .prepare(`SELECT value FROM memesh_metadata WHERE key = 'citation_sessions_cited'`)
            .get();
        const citationTotal = Number.parseInt(String(citationTotalRow?.value ?? ''), 10);
        if (Number.isInteger(citationTotal) && citationTotal > 0) {
            const citedKnown = citedRow?.value !== undefined;
            const cited = Number.parseInt(String(citedRow?.value ?? ''), 10);
            const rate = citedKnown && Number.isInteger(cited)
                ? Math.round((cited / citationTotal) * 100)
                : null;
            const ruleScope = readInstallMarker()?.scope === 'project' ? 'project' : 'user';
            let rule;
            try {
                rule = citationRuleState(ruleScope, homeDir(), process.cwd(), {
                    readFileSync: readFileSyncImpl,
                });
            }
            catch {
                rule = { path: citationRulePath(ruleScope, homeDir(), process.cwd()), state: 'unreadable' };
            }
            if (rate === null) {
                dbChecks.push(createInfo('citation_compliance', 'Memory use rate', `${citationTotal} session(s) received injected memories; how many cited or retrieved one is not recorded `
                    + `(this database predates the counter that would say). The rate will be measurable from the next session on.`));
            }
            else if (rate === 0) {
                dbChecks.push(createCheck('citation_compliance', 'Memory use rate', 'warn', `${citationTotal} session(s) received injected memories and NONE cited or retrieved one. Every injection is `
                    + `costing tokens with no evidence any of it was used — and with no citations or ID retrievals, ranking cannot `
                    + `learn which memories are worth injecting.`, rule.state === 'current'
                    ? `The citation contract is installed at ${rule.path}. If this stays at 0% across several more sessions, the injected memories are not earning their tokens — consider narrowing what is injected.`
                    : `The citation contract is ${rule.state} at ${rule.path}. Run 'memesh install-hooks' (or start a new session) to write it, then re-check after a few sessions.`, { code: 'citation.none', params: { total: citationTotal } }));
            }
            else {
                dbChecks.push(createInfo('citation_compliance', 'Memory use rate', `${cited} of ${citationTotal} session(s) with injected memories cited or retrieved at least one (${rate}%).`));
            }
        }
        try {
            let archiveRun = null;
            let archiveUnreadable = null;
            try {
                archiveRun = readLastAutoArchiveRun(db);
            }
            catch (err) {
                if (!(err instanceof AutoArchiveRecordUnreadable))
                    throw err;
                archiveUnreadable = err.message;
            }
            if (archiveUnreadable) {
                dbChecks.push(createCheck('auto_archive', 'Automatic archive', 'warn', `Cannot tell when it last ran: ${archiveUnreadable}. The record is rewritten the next time the archiver runs (at session start, at most once a day).`));
            }
            else if (archiveRun) {
                const byType = Object.entries(archiveRun.byType ?? {}).map(([t, n]) => `${n} ${t}`).join(', ');
                dbChecks.push(createInfo('auto_archive', 'Automatic archive', `Last run ${archiveRun.at}: ${archiveRun.archived} auto-captured memor${archiveRun.archived === 1 ? 'y' : 'ies'} archived`
                    + `${byType ? ` (${byType})` : ''}, unused for ${String(archiveRun.unusedDays ?? 14)} days`
                    + `${Number(archiveRun.keptCited) > 0 ? `; ${archiveRun.keptCited} old one(s) kept because a session cited them` : ''}. `
                    + `Memories an agent wrote are never archived this way. Read an archived one with 'memesh recall --include-archived'; `
                    + 'remember the same name again to bring it back.'));
            }
            else {
                dbChecks.push(createInfo('auto_archive', 'Automatic archive', 'Has not run yet. It runs at session start, at most once a day, and archives auto-captured commits and session '
                    + 'rollups that nobody used for 14 days.'));
            }
        }
        catch {
        }
    }
    catch (err) {
        dbChecks.length = 0;
        if (err instanceof NoDatabaseYetError) {
            const folderPath = path.dirname(databasePath);
            const folderLocked = !isWritable(folderPath) && fs.existsSync(folderPath);
            const notChecked = 'Not checked until then: message storage, the keyword index, guard activity, memory use rate, hook activity, capture liveness.';
            dbChecks.push(folderLocked
                ? createCheck('database', 'Database', 'warn', `No database yet at ${databasePath}, and ${folderPath} cannot be written, so MeMesh cannot create one: memories cannot be saved. ${notChecked}`, `chmod u+w ${shellQuote(folderPath)}`, { code: 'database.folder-read-only' })
                : createInfo('database', 'Database', `No database yet at ${databasePath}: MeMesh creates it the first time it stores a memory, and doctor never creates it. ${notChecked}`));
        }
        else if (isSchemaBehind(err)) {
            dbChecks.push(createCheck('database', 'Database', 'warn', `Database at ${databasePath} opened, but its layout is older than this version, so the checks that need the newer layout were skipped.`, schemaBehindNote(databasePath), { code: 'database.schema-behind' }));
        }
        else {
            const { diagnosis, fix } = diagnoseDatabaseFailure(err, databasePath, existsSyncImpl, statSyncImpl);
            dbChecks.push(createCheck('database', 'Database', 'fail', diagnosis, fix, { code: 'database.broken', params: { detail: diagnosis } }));
        }
    }
    finally {
        checks.push(...dbChecks);
        try {
            safeCloseDatabaseImpl();
        }
        catch {
        }
    }
    checks.push(inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl));
    checks.push(inspectMcpConfig(packageRoot, install, existsSyncImpl, readFileSyncImpl, envImpl));
    checks.push(...inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl));
    const pluginHost = detectPluginHost(packageRoot);
    let codexPluginCacheDetected = pluginHost === 'codex';
    let claudePluginCacheDetected = pluginHost === 'claude-code';
    const wiring = inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir(), install, installedPluginsPathImpl, pluginHost);
    const pluginCache = inspectPluginCacheCurrency(install, pluginHost, packageRoot, installedPluginsPathImpl, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl);
    if (pluginCache)
        checks.push(pluginCache);
    if (install === 'npm-global') {
        const discoveredCounts = new Map();
        const discoveredPluginCaches = pluginCacheDiscoveryImpl
            ? pluginCacheDiscoveryImpl()
            : defaultPluginCacheDiscovery(readFileSyncImpl, existsSyncImpl);
        for (const discovered of discoveredPluginCaches) {
            if (discovered.host === 'codex')
                codexPluginCacheDetected = true;
            if (discovered.host === 'claude-code')
                claudePluginCacheDetected = true;
            const check = discovered.unverifiableReason
                ? pluginCacheUnverifiable(discovered.host, discovered.unverifiableReason)
                : inspectPluginCacheCurrency('plugin-marketplace', discovered.host, discovered.packageRoot, discovered.installedPluginsPath, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl);
            if (check) {
                const hostName = discovered.host;
                const index = (discoveredCounts.get(discovered.host) ?? 0) + 1;
                discoveredCounts.set(discovered.host, index);
                checks.push({ ...check, id: `plugin-cache-${hostName}${index === 1 ? '' : `-${index}`}` });
            }
        }
    }
    checks.push(wiring);
    if (claudePluginCacheDetected) {
        checks.push(inspectClaudeChannelRegistration(existsSyncImpl, readFileSyncImpl));
    }
    const codexSessionSetup = inspectCodexSessionSetup(codexPluginCacheDetected, existsSyncImpl);
    if (codexSessionSetup)
        checks.push(codexSessionSetup);
    const captureWired = wiring.status === 'pass'
        && (wiring.params === undefined || wiring.params.captureWired === 1);
    checks.push(inspectHookActivity(openDatabaseImpl, safeCloseDatabaseImpl, existsSyncImpl, statSyncImpl, captureWired));
    const captureLiveness = withRecordedHosts(inspectCaptureLiveness(openDatabaseImpl, safeCloseDatabaseImpl, readFileSyncImpl, getMemeshDirFromDbPath, captureWired));
    checks.push(captureLiveness.check);
    const heldNotes = inspectPrivateNoteHolds();
    if (heldNotes)
        checks.push(heldNotes);
    const captureReport = captureLiveness.report;
    checks.push(inspectNodeRuntime(packageRoot, existsSyncImpl, readFileSyncImpl));
    checks.push(inspectNativeBinding(packageRoot, existsSyncImpl, nativeBindingProbeImpl));
    checks.push(inspectShellCli(install, packageRoot, packageVersion, resolveShellMemeshImpl, existsSyncImpl, readFileSyncImpl));
    checks.push(verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl, installSupport));
    checks.push(inspectMessageCapability(packageRoot, probeMessageCapability, messageCapabilityProbeImpl));
    checks.push(await inspectMessageRouterStatus(probeMessageRouterStatus, messageRouterStatusProbeImpl, lastRouterIdleExit));
    checks.push(inspectInstallJourney(packageVersion));
    checks.push(await inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport, packageRoot, statSyncImpl));
    checks.push(inspectAutoUpdate(installSupport));
    try {
        const record = readInstallRecordState();
        const installFile = path.join(memeshDir(), 'install.json');
        const sharing = 'Never transmitted automatically; `memesh feedback` includes it in the report text it prints or opens for you to submit, unless you pass `--no-diagnostics`.';
        checks.push(createInfo('install_id', 'Install ID', record.status === 'ok'
            ? `Anonymous install ID: ${record.install_id}${record.created_at ? ` (created ${record.created_at})` : ''}. Stored locally at ${installFile}. ${sharing}`
            : record.status === 'unreadable'
                ? `${installFile} exists but cannot be used (${record.reason}). Doctor does not touch it; the next \`memesh feedback\` with diagnostics replaces it with a new ID. ${sharing}`
                : `No install ID yet: it is created the first time \`memesh feedback\` builds a report with diagnostics (it would be stored locally at ${installFile}). Doctor does not create it. ${sharing}`));
    }
    catch {
    }
    checks.push(inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl));
    if (probeHttp) {
        checks.push(await inspectHttpProbe(httpBaseUrl, fetchImpl));
    }
    const hostState = hostFixState(wiring.code, codexPresent(existsSyncImpl, isOnPath));
    const finalChecks = checks.map((check) => withHostFix(check, hostState));
    return {
        status: summarizeOverallStatus(finalChecks),
        checks: finalChecks,
        ...(captureReport ? { capture: captureReport } : {}),
    };
}
function iconForStatus(status) {
    switch (status) {
        case 'pass':
            return 'PASS';
        case 'warn':
            return 'WARN';
        default:
            return 'FAIL';
    }
}
export function formatDoctorReport(result, packageVersion) {
    const lines = [`MeMesh doctor v${packageVersion}`, `Overall: ${result.status}`];
    for (const check of result.checks) {
        lines.push('');
        lines.push(`[${check.informational ? 'INFO' : iconForStatus(check.status)}] ${check.label}`);
        lines.push(`  ${check.summary}`);
        if (check.fix) {
            lines.push(`  Fix: ${check.fix}`);
        }
    }
    return lines;
}
//# sourceMappingURL=doctor.js.map