import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('user-facing CLI hints name registered flags', () => {
  const adviceSources = [
    'src/transports/cli/cli.ts',
    'src/core/operations.ts',
    'src/core/doctor.ts',
    'src/db.ts',
  ];

  it('accepts every recommended memesh command flag', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const cli = fs.readFileSync(path.join(repoRoot, 'src/transports/cli/cli.ts'), 'utf8');
    const registered = new Set(
      [...cli.matchAll(/\.(?:option|requiredOption)\(\s*'(--[a-z][a-z0-9-]*)/g)]
        .map((match) => match[1]),
    );
    expect(registered.size).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const relativePath of adviceSources) {
      const text = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const match of line.matchAll(/memesh\s+[a-z][a-z-]*\s+(--[a-z][a-z0-9-]*)/g)) {
          if (!registered.has(match[1])) {
            offenders.push(`${relativePath}:${index + 1} recommends ${match[1]}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
