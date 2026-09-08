import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('dashboard/src/styles/global.css', 'utf8');
function token(name: string): string {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing colour token ${name}`);
  return value;
}
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(start => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

// Source-level guard only: actual cascade, opacity, clipping and zoom need
// browser review in qa:ui-review on the frozen candidate.
describe('dashboard readability baseline', () => {
  for (const text of ['text-0', 'text-1', 'text-2', 'text-3']) {
    for (const background of ['bg-0', 'bg-1', 'bg-2', 'bg-hover']) {
      it(`${text} remains readable on ${background}`, () => {
        expect(contrast(token(text), token(background))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('detects the reported low-contrast palette as a controlled failure', () => {
    expect(contrast('#4B4D51', token('bg-0'))).toBeLessThan(4.5);
  });
  it('keeps the body baseline at a readable size', () => {
    expect(css).toMatch(/html\s*\{\s*font-size:\s*16px;/);
  });
  it('does not shrink shared interface text below 14px', () => {
    expect(css).not.toMatch(/font-size:\s*(?:[0-9]|1[0-3])px\b/);
    expect(css).not.toMatch(/font:\s*[^;\n]*\b(?:[0-9]|1[0-3])px\b/);
  });
  it('does not override readable shared styles with smaller component text', () => {
    const violations = readdirSync('dashboard/src/components')
      .filter(file => file.endsWith('.tsx'))
      .flatMap(file => readFileSync(`dashboard/src/components/${file}`, 'utf8')
        .split('\n')
        .flatMap((line, index) => !(file === 'ProjectRoadmap.tsx' && line.includes('aria-hidden="true"') && line.includes('fontSize: 10, width: 10, flexShrink: 0')) && /fontSize:\s*(?:(?:[0-9]|1[0-3])\b|['"](?:[0-9]|1[0-3])px['"])|font:\s*['"][^'"\n]*\b(?:[0-9]|1[0-3])px\b/.test(line)
          ? [`${file}:${index + 1}: ${line.trim()}`] : []));
    expect(violations).toEqual([]);
  });
  it('keeps tag counts from shrinking analytics labels', () => {
    const source = readFileSync('dashboard/src/components/AnalyticsTab.tsx', 'utf8');
    expect(source).toContain('key={tg.tag} class="tag" style={{ fontSize: 14 }}');
  });
});
