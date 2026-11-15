// ============================================================================
// AUTO-GENERATED from src/core/prompt-recall.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { hasTables, MEMORY_READ_TABLES } from './schema.js';
import { renderPhraseExpression, tokenizeQuery, UNSPACED_SCRIPT_CLASS } from './fts-index.js';
import { buildReferenceContext, isAutoInjectable } from './work-topology.js';
import { redactShownTogether } from './core-paths.js';
import { AUTO_CONTEXT_EXCLUDED_TYPES, autoContextScope, projectAliases, recentTitle, tableColumns, } from './recent-index.js';
export const PROMPT_RECALL_MAX_LINES = 2;
export const PROMPT_RECALL_MAX_BYTES = 4096;
export const PROMPT_RECALL_MIN_COVERAGE = 0;
export const PROMPT_RECALL_MIN_TERMS = 1;
const PROMPT_CHARS = 1500;
const MAX_TERMS = 12;
export const PROMPT_RECALL_SKIP_TYPES = new Set();
export const PROMPT_RECALL_MAX_PROJECT_AGE_DAYS = 30;
const CANDIDATE_WINDOW = 30;
const SCORED_TEXT_CHARS = 20000;
const MAX_LATIN_TERMS = 60;
const MAX_CJK_TERMS = 30;
const EXCLUDE_OWN_CONVERSATION_SQL = " AND (e.type <> 'conversation' OR NOT EXISTS (SELECT 1 FROM tags own_session WHERE own_session.entity_id = e.id AND own_session.tag = ?))";
const EXCLUDED_TYPES = AUTO_CONTEXT_EXCLUDED_TYPES;
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'were', 'you', 'your', 'with', 'this', 'that', 'these', 'those',
    'have', 'has', 'had', 'not', 'but', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
    'how', 'what', 'why', 'when', 'where', 'who', 'which', 'does', 'did', 'done', 'doing', 'please',
    'about', 'from', 'into', 'than', 'then', 'them', 'they', 'there', 'their', 'its', 'our', 'out',
    'just', 'also', 'any', 'all', 'now', 'use', 'using', 'get', 'got', 'let', 'make', 'need', 'want',
    'like', 'some', 'more', 'most', 'one', 'two', 'yes', 'okay', 'ok', 'go', 'on', 'it', 'is', 'in',
    'of', 'to', 'we', 'be', 'do', 'if', 'or', 'an', 'as', 'at', 'by', 'so', 'no', 'me', 'my', 'up',
]);
function fold(term) {
    const lower = term.toLowerCase();
    return /^[\p{Script=Latin}\p{M}\p{N}]+$/u.test(lower) ? lower.normalize('NFD').replace(/\p{M}/gu, '') : lower;
}
const CJK_RUN = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]+`, 'gu');
const CJK_ONE = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]`, 'u');
let segmenters = null;
function segmentWords(run) {
    try {
        if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function')
            return null;
        segmenters ??= new Map();
        const locale = /[぀-ヿ]/u.test(run) ? 'ja' : /[가-힯]/u.test(run) ? 'ko' : 'zh-Hant';
        let seg = segmenters.get(locale);
        if (!seg) {
            seg = new Intl.Segmenter(locale, { granularity: 'word' });
            segmenters.set(locale, seg);
        }
        return [...seg.segment(run)].filter((s) => s.isWordLike).map((s) => s.segment);
    }
    catch {
        return null;
    }
}
function cjkWords(run) {
    const words = segmentWords(run);
    if (words === null) {
        const chars = [...run];
        return chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
    }
    const out = [];
    let singles = '';
    const flush = () => { if ([...singles].length >= 2)
        out.push(singles); singles = ''; };
    for (const w of words) {
        if ([...w].length === 1) {
            singles += w;
            continue;
        }
        flush();
        out.push(w);
    }
    flush();
    return out;
}
function promptTerms(prompt) {
    const text = prompt.slice(0, PROMPT_CHARS).replace(/<\/?[A-Za-z][\w-]*>/g, ' ').normalize('NFC');
    const seen = new Set();
    const latin = [];
    const cjk = [];
    for (const raw of text.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? []) {
        const word = fold(raw);
        if (word.length < 2 || STOP_WORDS.has(word) || seen.has(word))
            continue;
        seen.add(word);
        if (latin.length < MAX_LATIN_TERMS)
            latin.push({ text: word, cjk: false, match: `"${word.replace(/"/g, '""')}"` });
    }
    for (const run of text.match(CJK_RUN) ?? []) {
        for (const word of cjkWords(run)) {
            const folded = word.toLowerCase();
            if (seen.has(folded) || !CJK_ONE.test(folded))
                continue;
            seen.add(folded);
            const match = renderPhraseExpression(tokenizeQuery(folded));
            if (match !== null && cjk.length < MAX_CJK_TERMS)
                cjk.push({ text: folded, cjk: true, match });
        }
    }
    return [...latin, ...cjk];
}
function documentFrequencies(db, terms, excludeSession) {
    const df = new Map();
    if (excludeSession !== undefined) {
        const countOther = db.prepare(`SELECT count(*) AS c FROM entities_fts JOIN entities e ON e.id = entities_fts.rowid WHERE entities_fts MATCH ?${EXCLUDE_OWN_CONVERSATION_SQL}`);
        for (const term of terms)
            df.set(term.text, countOther.get(term.match, `session:${excludeSession}`).c);
        return df;
    }
    const count = db.prepare('SELECT count(*) AS c FROM entities_fts WHERE entities_fts MATCH ?');
    const plain = terms.filter((t) => !t.cjk);
    if (plain.length > 0) {
        try {
            const rows = db
                .prepare(`SELECT term, doc FROM fts_vocab WHERE term IN (${plain.map(() => '?').join(',')})`)
                .all(...plain.map((t) => t.text));
            for (const t of plain)
                df.set(t.text, 0);
            for (const r of rows)
                df.set(r.term, r.doc);
        }
        catch {
            for (const t of plain)
                df.set(t.text, count.get(t.match).c);
        }
    }
    for (const t of terms.filter((x) => x.cjk))
        df.set(t.text, count.get(t.match).c);
    return df;
}
function parseMetadata(raw) {
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
export function scorePrompt(db, prompt, options) {
    const all = promptTerms(prompt);
    if (all.length === 0)
        return { scored: [], terms: [] };
    if (!hasTables(db, [...MEMORY_READ_TABLES, 'entities_fts']))
        return { scored: [], terms: all.map((t) => t.text) };
    const entityCols = tableColumns(db, 'entities');
    const ownConversation = options.excludeConversationSession === undefined ? '' : EXCLUDE_OWN_CONVERSATION_SQL;
    const ownParams = options.excludeConversationSession === undefined ? [] : [`session:${options.excludeConversationSession}`];
    const total = db.prepare(`SELECT count(*) AS c FROM entities e WHERE 1=1${entityCols.has('status') ? " AND e.status = 'active'" : ''}${ownConversation}`).get(...ownParams).c;
    const df = documentFrequencies(db, all, options.excludeConversationSession);
    const idf = (term) => {
        const n = df.get(term.text) ?? 0;
        return Math.log(1 + (total - n + 0.5) / (n + 0.5));
    };
    const informative = all
        .filter((t) => (df.get(t.text) ?? 0) > 0)
        .map((t) => ({ term: t, weight: idf(t) }))
        .sort((a, b) => b.weight - a.weight || (a.term.text < b.term.text ? -1 : 1))
        .slice(0, MAX_TERMS);
    if (informative.length === 0)
        return { scored: [], terms: [] };
    const promptWeight = informative.reduce((sum, t) => sum + t.weight, 0);
    const match = informative.map((t) => t.term.match).join(' OR ');
    const scope = autoContextScope(projectAliases(options.project, options.cwd), options.platform);
    const before = options.createdBefore === undefined ? null : new Date(options.createdBefore).toISOString();
    const skipTypes = [...(options.skipTypes ?? PROMPT_RECALL_SKIP_TYPES)];
    const maxProjectAgeDays = options.maxProjectAgeDays === undefined ? PROMPT_RECALL_MAX_PROJECT_AGE_DAYS : options.maxProjectAgeDays;
    const asOfMs = options.createdBefore ?? Date.now();
    const rows = db.prepare(`SELECT e.id, e.name, e.type, ${entityCols.has('title') ? 'e.title' : 'NULL AS title'}, e.metadata, fts.rank AS rank
     FROM entities_fts fts JOIN entities e ON e.id = fts.rowid
     WHERE entities_fts MATCH ?${entityCols.has('status') ? " AND e.status = 'active'" : ''}
       AND e.type NOT IN (${[...EXCLUDED_TYPES, ...skipTypes].map(() => '?').join(',')})
       AND (e.type = 'conversation' OR NOT EXISTS (SELECT 1 FROM tags ac WHERE ac.entity_id = e.id AND ac.tag = 'source:auto-capture'))
       AND ${scope.sql}
       ${ownConversation}
       ${before === null ? '' : 'AND julianday(e.created_at) < julianday(?)'}
     ORDER BY fts.rank, e.id DESC
     LIMIT ?`).all(match, ...EXCLUDED_TYPES, ...skipTypes, ...scope.params, ...(options.excludeConversationSession === undefined ? [] : [`session:${options.excludeConversationSession}`]), ...(before === null ? [] : [before]), CANDIDATE_WINDOW);
    const observations = db.prepare(`SELECT content, created_at FROM observations WHERE entity_id = ?${before === null ? '' : ' AND julianday(created_at) < julianday(?)'} ORDER BY id`);
    const scored = [];
    for (const row of rows) {
        const meta = parseMetadata(row.metadata);
        if (meta === undefined || !isAutoInjectable(meta))
            continue;
        const read = (before === null ? observations.all(row.id) : observations.all(row.id, before));
        if (before !== null && read.length === 0)
            continue;
        if (maxProjectAgeDays !== null && row.type === 'project') {
            const noteMs = options.projectAgeFromNoteDate !== false
                ? meta?.provenance
                : undefined;
            const fromNote = noteMs?.source === 'note-file' && typeof noteMs.note_mtime_ms === 'number' ? noteMs.note_mtime_ms : null;
            const newest = fromNote ?? Math.max(...read.map((o) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(o.created_at) ? o.created_at : `${o.created_at.replace(' ', 'T')}Z`)));
            if (Number.isFinite(newest) && (asOfMs - newest) / 86_400_000 > maxProjectAgeDays)
                continue;
        }
        const head = [row.name, row.title ?? ''].join(' ');
        const body = read.map((o) => o.content).join(' ').slice(0, SCORED_TEXT_CHARS);
        const headTerms = new Set(tokenizeQuery(head).map(fold));
        const bodyTerms = new Set(tokenizeQuery(body).map(fold));
        const headText = head.normalize('NFC').toLowerCase();
        const bodyText = body.normalize('NFC').toLowerCase();
        const inHead = (t) => (t.cjk ? headText.includes(t.text) : headTerms.has(t.text));
        const inBody = (t) => (t.cjk ? bodyText.includes(t.text) : bodyTerms.has(t.text));
        const hits = informative.filter(({ term }) => inHead(term) || inBody(term));
        if (hits.length === 0)
            continue;
        const mass = hits.reduce((sum, t) => sum + t.weight, 0);
        scored.push({
            id: row.id,
            name: row.name,
            type: row.type,
            title: row.title,
            coverage: mass / promptWeight,
            matched: hits.map((t) => t.term.text),
            mass,
            inTitle: hits.some(({ term }) => inHead(term)),
            rank: row.rank,
            ...(row.type === 'conversation'
                ? { conversationRole: (db.prepare("SELECT 1 FROM tags WHERE entity_id = ? AND tag = 'role:assistant' LIMIT 1").get(row.id) ? 'assistant' : 'user') }
                : {}),
        });
    }
    scored.sort((a, b) => b.coverage - a.coverage || b.matched.length - a.matched.length || a.rank - b.rank || b.id - a.id);
    return { scored, terms: informative.map((t) => t.term.text) };
}
function contentContext(db, hits, before) {
    const observations = db.prepare(`SELECT content FROM observations WHERE entity_id = ?${before === undefined ? '' : ' AND julianday(created_at) < julianday(?)'} ORDER BY id`);
    const rows = hits.map((hit) => {
        const read = (before === undefined
            ? observations.all(hit.id)
            : observations.all(hit.id, new Date(before).toISOString()));
        const [title, ...body] = redactShownTogether([hit.title ?? hit.name, ...read.map((o) => o.content)]);
        const label = recentTitle({ ...hit, title, name: title ?? '' });
        return { hit, label, points: Array.from(body.join('\n')) };
    });
    const lines = rows.map(({ hit, label }) => `- ${label} [mem:${hit.id}]`);
    for (const [index, { hit, label, points }] of rows.entries()) {
        const used = Buffer.byteLength(buildReferenceContext(lines), 'utf8');
        const limit = used + Math.floor((PROMPT_RECALL_MAX_BYTES - used) / (rows.length - index));
        const line = (count) => `- ${label}${count ? ` — ${points.slice(0, count).join('')}` : ''}${count < points.length ? ` … [content truncated; recall ids=[${hit.id}] for full text]` : ''} [mem:${hit.id}]`;
        const fits = (count) => {
            const candidate = [...lines];
            candidate[index] = line(count);
            return Buffer.byteLength(buildReferenceContext(candidate), 'utf8') <= limit;
        };
        let low = 0;
        let high = points.length;
        if (!fits(high)) {
            high--;
            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                if (fits(middle))
                    low = middle;
                else
                    high = middle - 1;
            }
        }
        else
            low = high;
        lines[index] = line(low);
    }
    return buildReferenceContext(lines);
}
export function selectPromptRecall(db, prompt, options) {
    const { scored, terms } = scorePrompt(db, prompt, options);
    if (terms.length === 0)
        return { text: '', ids: [], reason: 'no-terms', scored, terms };
    if (scored.length === 0)
        return { text: '', ids: [], reason: 'no-candidates', scored, terms };
    const minCoverage = options.minCoverage ?? PROMPT_RECALL_MIN_COVERAGE;
    const minTerms = options.minTerms ?? PROMPT_RECALL_MIN_TERMS;
    const maxLines = Math.min(options.maxLines ?? PROMPT_RECALL_MAX_LINES, PROMPT_RECALL_MAX_LINES);
    const top = [];
    let assistantConversations = 0;
    for (const match of scored) {
        if (match.coverage < minCoverage || match.matched.length < minTerms)
            continue;
        if (match.conversationRole === 'assistant' && assistantConversations >= 1)
            continue;
        top.push(match);
        if (match.conversationRole === 'assistant')
            assistantConversations++;
        if (top.length >= maxLines)
            break;
    }
    if (top.length === 0)
        return { text: '', ids: [], reason: 'below-threshold', scored, terms };
    const fresh = top.filter((m) => !options.exclude?.has(m.id));
    if (fresh.length === 0)
        return { text: '', ids: [], reason: 'already-shown', scored, terms };
    return { text: contentContext(db, fresh, options.createdBefore), ids: fresh.map((m) => m.id), scored, terms };
}
