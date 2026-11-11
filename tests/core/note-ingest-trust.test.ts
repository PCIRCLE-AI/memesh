import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { ingestNoteDirectory } from '../../src/core/note-ingest.js';
import { isAutoInjectable } from '../../src/core/work-topology.js';
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

describe('Feature: opening the database changes no note\'s trust', () => {
  it('an untrusted note of a folder that looks like the person\'s own stays untrusted across opens, with no copy made and no marker written', () => {
    // The shape the removed open-time repair used to act on: a note memory whose recorded folder is a
    // `<claude home>/projects/<project>/memory` folder that exists, stored untrusted.
    const claudeHome = path.join(fixture.tmpDir, 'claude-home');
    const own = path.join(claudeHome, 'projects', 'proj', 'memory');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'a.md'), note('own_old', 'feedback', 'From my own folder.'));
    fs.writeFileSync(path.join(own, 'd.md'), note('own_decision', 'decision', 'Use tabs.'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
    expect(fs.readdirSync(own)).toHaveLength(2);
    ingestNoteDirectory({ dir: own, project: 'p', trusted: false });
    expect(['own_old', 'own_decision'].map((n) => metaOf(n).trust)).toEqual(['untrusted', 'untrusted']);
    // A database that has never opened under this rule: no marker of any open-time pass.
    getDatabase().prepare("DELETE FROM memesh_metadata WHERE key LIKE 'own_note_folder_trust%'").run();

    for (let i = 0; i < 2; i++) {
      closeDatabase();
      openDatabase(fixture.dbPath);
      expect(['own_old', 'own_decision'].map((n) => metaOf(n).trust)).toEqual(['untrusted', 'untrusted']);
    }
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM memesh_metadata WHERE key LIKE 'own_note_folder_trust%' OR key LIKE 'note_trust_lifted%'").get()).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(path.dirname(fixture.dbPath), 'backups'))).toBe(false);
  });
});
