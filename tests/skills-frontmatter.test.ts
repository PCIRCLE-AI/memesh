/**
 * Every skill's front matter must be valid YAML, because the host reads it with a strict parser.
 * `skills/memesh/SKILL.md` once had an unquoted `description` containing `: `, which YAML reads as
 * the start of a nested mapping: the whole block failed to parse. No YAML parser is a dependency
 * here, so this checks the rule that was broken: a plain scalar must not contain `: ` or ` #`,
 * and a scalar that has to must be quoted.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const skillsDir = path.resolve(__dirname, '..', 'skills');
const skills = fs.readdirSync(skillsDir).filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')));

/** The lines of the block between the first two `---`, and what is wrong with each, if anything. */
export function frontmatterProblems(text: string): string[] {
  const lines = text.split('\n');
  if (lines[0] !== '---') return ['does not start with ---'];
  const end = lines.indexOf('---', 1);
  if (end === -1) return ['front matter is not closed'];
  const problems: string[] = [];
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z][\w-]*):(?: (.*))?$/);
    if (!match) { if (line.trim() !== '' && !/^\s/.test(line)) problems.push(`not a key: ${line.slice(0, 40)}`); continue; }
    const value = match[2] ?? '';
    if (/^["'|>[{]/.test(value)) {
      if (value.startsWith('"') && !/^"(?:[^"\\]|\\.)*"$/.test(value)) problems.push(`${match[1]}: a double-quoted value that does not end where it should`);
      continue;
    }
    if (value.includes(': ') || value.includes(' #')) problems.push(`${match[1]}: an unquoted value contains ": " or " #"`);
  }
  return problems;
}

describe('skill front matter', () => {
  it('finds the skills', () => {
    expect(skills).toContain('memesh');
  });

  it.each(skills)('%s has a front matter that a strict YAML parser reads', (name) => {
    expect(frontmatterProblems(fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'))).toHaveLength(0);
  });

  it('recognises the defect it exists for', () => {
    expect(frontmatterProblems('---\nname: x\ndescription: Use it. Triggers when: the user asks\n---\n')).toHaveLength(1);
    expect(frontmatterProblems('---\nname: x\ndescription: "Use it. Triggers when: the user asks"\n---\n')).toHaveLength(0);
    expect(frontmatterProblems('---\nname: x\ndescription: "broken " quote"\n---\n')).toHaveLength(1);
  });
});
