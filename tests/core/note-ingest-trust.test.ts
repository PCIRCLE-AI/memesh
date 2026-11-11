import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { ingestNoteDirectory } from '../../src/core/note-ingest.js';
import { noteDirId, ownMemoryDirIds } from '../../src/core/note-dirs.js';
import { isAutoInjectable } from '../../src/core/work-topology.js';
import { trustOwnNoteFolderMemories, repairOwnNoteFolderTrust } from '../../src/storage/graph-repairs.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const fixture = useTestDatabase('memesh-note-trust-');
const kg = () => new KnowledgeGraph(getDatabase());

afterEach(() => { vi.unstubAllEnvs(); });

const note = (name: string, type: string, body: string) =>
  `---\nname: ${name}\ndescription: "${name} title"\nmetadata: \n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`;

function folder(rel: string, files: Record<string, string>): string {
  const dir = path.join(fixture.tmpDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}
const metaOf = (name: string) => kg().getEntity(name)!.metadata as { trust?: string; provenance?: { source?: string; note_dir_id?: string } };

describe('Feature: trust of note memories is decided by the caller, per folder', () => {
  it('trusted: true stores memories that sessions may be shown, like any memory an agent stores', () => {
    const dir = folder('own', { 'a.md': note('own_note', 'feedback', 'Always answer in Traditional Chinese.') });
    ingestNoteDirectory({ dir, project: 'p', trusted: true });
    expect(metaOf('own_note').trust).toBe('trusted');
    expect(isAutoInjectable(metaOf('own_note'))).toBe(true);
  });

  it('trusted: false keeps them out of what a session is shown', () => {
    const dir = folder('other', { 'a.md': note('other_note', 'feedback', 'Some text from a folder.') });
    ingestNoteDirectory({ dir, project: 'p', trusted: false });
    expect(metaOf('other_note').trust).toBe('untrusted');
    expect(isAutoInjectable(metaOf('other_note'))).toBe(false);
  });

  it('a trusted note read again after edits does not lift its confidence', () => {
    const dir = folder('own', { 'a.md': note('steady', 'feedback', 'First version.') });
    ingestNoteDirectory({ dir, project: 'p', trusted: true });
    // A new entity starts at the 1.0 ceiling, where a lift is invisible: lower it
    // first so a lift, if there were one, shows.
    getDatabase().prepare("UPDATE entities SET confidence = 0.5 WHERE name = 'steady'").run();
    const before = (getDatabase().prepare("SELECT confidence FROM entities WHERE name = 'steady'").get() as { confidence: number }).confidence;
    expect(before).toBe(0.5);
    for (const body of ['Second version.', 'Third version.', 'Fourth version.']) {
      fs.writeFileSync(path.join(dir, 'a.md'), note('steady', 'feedback', body));
      ingestNoteDirectory({ dir, project: 'p', trusted: true });
    }
    const after = (getDatabase().prepare("SELECT confidence FROM entities WHERE name = 'steady'").get() as { confidence: number }).confidence;
    expect(after).toBe(before);
    expect(kg().getEntity('steady')!.observations).toEqual(['Fourth version.']);
  });

  it('a decision note without a stated reason, even in the own folder, is stored as written, not refused, and stays untrusted', () => {
    const dir = folder('own', { 'd.md': note('plain_decision', 'decision', 'Use tabs.') });
    const result = ingestNoteDirectory({ dir, project: 'p', trusted: true });
    expect(result.created).toEqual(['plain_decision']);
    expect(result.skipped).toEqual([]);
    expect(metaOf('plain_decision').trust).toBe('untrusted');
  });
});

describe('Feature: the person\'s own memory folders are found by the id their notes record', () => {
  it('lists each existing <claude home>/projects/*/memory folder, and nothing else', () => {
    const claudeHome = path.join(fixture.tmpDir, 'claude-home');
    fs.mkdirSync(path.join(claudeHome, 'projects', 'one', 'memory'), { recursive: true });
    fs.mkdirSync(path.join(claudeHome, 'projects', 'two', 'memory'), { recursive: true });
    fs.mkdirSync(path.join(claudeHome, 'projects', 'three'), { recursive: true });
    fs.mkdirSync(path.join(fixture.tmpDir, 'elsewhere'), { recursive: true });
    const ids = ownMemoryDirIds({ CLAUDE_CONFIG_DIR: claudeHome });
    expect(ids).toEqual(new Set([
      noteDirId(fs.realpathSync(path.join(claudeHome, 'projects', 'one', 'memory'))),
      noteDirId(fs.realpathSync(path.join(claudeHome, 'projects', 'two', 'memory'))),
    ]));
    expect(ids.has(noteDirId(fs.realpathSync(path.join(fixture.tmpDir, 'elsewhere'))))).toBe(false);
  });
});

describe('Feature: notes already stored from the person\'s own folders become trusted, once, and nothing else changes', () => {
  function seed() {
    const claudeHome = path.join(fixture.tmpDir, 'claude-home');
    const own = path.join(claudeHome, 'projects', 'proj', 'memory');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'a.md'), note('own_old', 'feedback', 'From my own folder.'));
    const other = folder('downloads-notes', { 'b.md': note('other_old', 'feedback', 'From some other folder.') });
    ingestNoteDirectory({ dir: own, project: 'p', trusted: false });
    ingestNoteDirectory({ dir: other, project: 'p', trusted: false });
    // An import: untrusted, from a bundle, not a note file.
    kg().createEntity('imported_one', 'feedback', { observations: ['from a bundle'], metadata: { trust: 'untrusted', provenance: { source: 'import' } }, trustOverride: 'untrusted' });
    // A note whose provenance names no folder.
    kg().createEntity('no_folder', 'feedback', { observations: ['odd'], tags: ['source:note-file'], metadata: { trust: 'untrusted', provenance: { source: 'note-file' } }, trustOverride: 'untrusted' });
    // An import that carries an own-folder id (a bundle that copied a note's
    // provenance fields): its source is `import`, so it is not a note.
    const ownId = noteDirId(fs.realpathSync(own));
    kg().createEntity('imported_with_dir', 'feedback', { observations: ['bundle'], tags: ['source:note-file'], metadata: { trust: 'untrusted', provenance: { source: 'import', note_dir_id: ownId } }, trustOverride: 'untrusted' });
    return { claudeHome };
  }
  const trustOf = (name: string) => metaOf(name).trust;

  it('trusts the own-folder note only; other folders, imports and rows with no folder stay untrusted', () => {
    const { claudeHome } = seed();
    const ids = ownMemoryDirIds({ CLAUDE_CONFIG_DIR: claudeHome });
    expect(ids.size).toBe(1);
    expect(['own_old', 'other_old', 'imported_one', 'no_folder', 'imported_with_dir'].map(trustOf)).toEqual(['untrusted', 'untrusted', 'untrusted', 'untrusted', 'untrusted']);

    expect(trustOwnNoteFolderMemories(getDatabase(), ids)).toBe(1);
    expect(['own_old', 'other_old', 'imported_one', 'no_folder', 'imported_with_dir'].map(trustOf)).toEqual(['trusted', 'untrusted', 'untrusted', 'untrusted', 'untrusted']);
    // Provenance is intact.
    expect(metaOf('own_old').provenance?.source).toBe('note-file');
  });

  it('is idempotent: a second pass changes no row', () => {
    const { claudeHome } = seed();
    const ids = ownMemoryDirIds({ CLAUDE_CONFIG_DIR: claudeHome });
    const snapshot = () => JSON.stringify(getDatabase().prepare('SELECT id, metadata FROM entities ORDER BY id').all());
    expect(trustOwnNoteFolderMemories(getDatabase(), ids)).toBe(1);
    const afterFirst = snapshot();
    expect(trustOwnNoteFolderMemories(getDatabase(), ids)).toBe(0);
    expect(snapshot()).toBe(afterFirst);
  });

  it('with no own folder on this machine it changes nothing, and the open-time pass runs once', () => {
    seed();
    expect(trustOwnNoteFolderMemories(getDatabase(), new Set())).toBe(0);
    expect(trustOf('own_old')).toBe('untrusted');
    getDatabase().prepare("DELETE FROM memesh_metadata WHERE key LIKE 'own_note_folder_trust_v1%'").run();
    const { claudeHome } = { claudeHome: path.join(fixture.tmpDir, 'claude-home') };
    expect(repairOwnNoteFolderTrust(getDatabase(), ownMemoryDirIds({ CLAUDE_CONFIG_DIR: claudeHome }))).toBe(1);
    expect(repairOwnNoteFolderTrust(getDatabase(), ownMemoryDirIds({ CLAUDE_CONFIG_DIR: claudeHome }))).toBe(-1);
  });
});
