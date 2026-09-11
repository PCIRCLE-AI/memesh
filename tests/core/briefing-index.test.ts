/**
 * #323 — the briefing index: one line per durable memory, newest first,
 * hard-capped. Pure builder tests; the database wiring is covered in
 * briefing.test.ts (core) and session-start.test.ts (hook).
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import {
  buildBriefingIndex,
  INDEX_EXCLUDED_TYPES,
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  INDEX_STALE_DAYS,
  isIndexableType,
  type IndexCandidate,
} from '../../src/core/briefing-index.js';
import { EVIDENCE_LAYER_TYPES } from '../../src/core/work-topology.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = 'index-fixture';

function sqliteTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function candidate(id: number, overrides: Partial<IndexCandidate> = {}): IndexCandidate {
  return {
    id,
    type: 'decision',
    title: `Decision number ${id}`,
    snippet: `Because reason ${id} held at the time.`,
    lastActivity: sqliteTs(NOW - id * 60_000),
    metadata: null,
    ...overrides,
  };
}

const bytes = (lines: string[]) => new TextEncoder().encode(lines.join('\n') + '\n').length;

describe('buildBriefingIndex', () => {
  it('renders one line per durable memory with its [mem:id] handle, newest first', () => {
    const idx = buildBriefingIndex([candidate(3), candidate(1), candidate(2)], PROJECT, NOW);
    expect(idx.lines[0]).toBe(`Index of durable memories for "${PROJECT}" (newest first):`);
    const memLines = idx.lines.filter((l) => /\[mem:\d+\]$/.test(l));
    expect(memLines).toEqual([
      '- [decision] Decision number 1 — Because reason 1 held at the time. [mem:1]',
      '- [decision] Decision number 2 — Because reason 2 held at the time. [mem:2]',
      '- [decision] Decision number 3 — Because reason 3 held at the time. [mem:3]',
    ]);
    expect(idx.ids).toEqual([1, 2, 3]);
    expect(idx.shown).toBe(3);
  });

  it('breaks equal timestamps by id, so two independent queries agree on order', () => {
    const ts = sqliteTs(NOW - DAY);
    const idx = buildBriefingIndex(
      [candidate(5, { lastActivity: ts }), candidate(9, { lastActivity: ts }), candidate(7, { lastActivity: ts })],
      PROJECT, NOW,
    );
    expect(idx.ids).toEqual([9, 7, 5]);
  });

  it('does not print the snippet again when the title was derived from it', () => {
    const idx = buildBriefingIndex(
      [candidate(1, { title: 'Use PKCE for the CLI', snippet: 'Use PKCE for the CLI because it cannot hold a secret.' })],
      PROJECT, NOW,
    );
    expect(idx.lines[1]).toBe('- [decision] Use PKCE for the CLI [mem:1]');
  });

  it('excludes exactly the evidence layer and task-state — pinned to the type constants', () => {
    // The exclusion list is DERIVED from EVIDENCE_LAYER_TYPES, not restated:
    // a type classified as evidence there is out of the index here.
    expect(new Set(INDEX_EXCLUDED_TYPES)).toEqual(new Set([...EVIDENCE_LAYER_TYPES, 'task-state']));
    const evidence = [...EVIDENCE_LAYER_TYPES].map((type, i) => candidate(100 + i, { type }));
    const idx = buildBriefingIndex(
      [...evidence, candidate(1, { type: 'task-state' }), candidate(2, { type: 'lesson_learned' }), candidate(3, { type: 'reference' })],
      PROJECT, NOW,
    );
    expect(idx.ids).toEqual([2, 3]);
    for (const type of EVIDENCE_LAYER_TYPES) expect(isIndexableType(type)).toBe(false);
    // A type nobody has classified yet defaults INTO the index.
    expect(isIndexableType('a-type-invented-later')).toBe(true);
  });

  it('applies the auto-injection gate: untrusted and imported memories are not listed', () => {
    const idx = buildBriefingIndex(
      [
        candidate(1, { metadata: { trust: 'untrusted' } }),
        candidate(2, { metadata: { provenance: { source: 'import' } } }),
        candidate(3),
      ],
      PROJECT, NOW,
    );
    expect(idx.ids).toEqual([3]);
  });

  it('redacts secrets and user paths before a line reaches a prompt', () => {
    const home = os.homedir();
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    const idx = buildBriefingIndex(
      [candidate(1, { title: 'Deploy key', snippet: `export KEY=${key} from ${home}/secrets/env` })],
      PROJECT, NOW,
    );
    const text = idx.lines.join('\n');
    expect(text).not.toContain(key);
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).toContain('***REDACTED***');
    expect(text).not.toContain(home);
    expect(text).toContain('~/secrets/env');
  });

  it('collapses memories older than the staleness window into one line', () => {
    const old = sqliteTs(NOW - (INDEX_STALE_DAYS + 1) * DAY);
    const idx = buildBriefingIndex(
      [candidate(1), candidate(2, { lastActivity: old }), candidate(3, { lastActivity: old })],
      PROJECT, NOW,
    );
    expect(idx.ids).toEqual([1]);
    expect(idx.older).toBe(2);
    expect(idx.lines).toContain(`- 2 older memories (no change in ${INDEX_STALE_DAYS} days) — recall to see`);
    // Just inside the window is still current.
    const fresh = buildBriefingIndex(
      [candidate(4, { lastActivity: sqliteTs(NOW - (INDEX_STALE_DAYS - 1) * DAY) })],
      PROJECT, NOW,
    );
    expect(fresh.ids).toEqual([4]);
    expect(fresh.older).toBe(0);
  });

  it('caps at INDEX_MAX_LINES and says how many more, with the recall command', () => {
    const many = Array.from({ length: INDEX_MAX_LINES + 15 }, (_, i) =>
      candidate(i + 1, { title: `D${i + 1}`, snippet: null }));
    const idx = buildBriefingIndex(many, PROJECT, NOW);
    expect(idx.shown).toBe(INDEX_MAX_LINES);
    expect(idx.more).toBe(15);
    expect(idx.lines).toContain(`- 15 more — memesh recall --tag project:${PROJECT}`);
    expect(bytes(idx.lines)).toBeLessThanOrEqual(INDEX_MAX_BYTES);
  });

  it('caps the whole section at INDEX_MAX_BYTES, counted in UTF-8 bytes', () => {
    // CJK is three bytes per character: a character-count cap would ship ~3x
    // the budget. Long lines hit the byte cap long before the line cap.
    const cjk = '記憶'.repeat(60);
    const many = Array.from({ length: 30 }, (_, i) => candidate(i + 1, { title: cjk, snippet: null }));
    const idx = buildBriefingIndex(many, PROJECT, NOW, { truncated: true });
    expect(idx.shown).toBeLessThan(30);
    expect(idx.shown).toBeGreaterThan(0);
    expect(bytes(idx.lines)).toBeLessThanOrEqual(INDEX_MAX_BYTES);
    expect(idx.lines).toContain(`- ${30 - idx.shown}+ more — memesh recall --tag project:${PROJECT}`);
  });

  it('reports its own cost in the footer', () => {
    const idx = buildBriefingIndex([candidate(1), candidate(2)], PROJECT, NOW);
    const above = idx.lines.slice(0, -1);
    expect(idx.bytes).toBe(bytes(above));
    expect(idx.tokens).toBe(Math.ceil(idx.bytes / 4));
    expect(idx.lines.at(-1)).toBe(
      `(index cost: 2 lines, ${idx.bytes} bytes ≈ ${idx.tokens} tokens; cap ${INDEX_MAX_LINES} lines / ${INDEX_MAX_BYTES} bytes)`,
    );
  });

  it('an empty project gets the empty-state line, not nothing', () => {
    const idx = buildBriefingIndex([candidate(1, { type: 'commit' })], PROJECT, NOW);
    expect(idx.shown).toBe(0);
    expect(idx.lines).toContain(
      `- No durable memories (decisions, lessons, patterns, references) for "${PROJECT}" yet.`,
    );
    expect(idx.lines.at(-1)).toMatch(/^\(index cost: 0 lines, \d+ bytes/);
  });
});
