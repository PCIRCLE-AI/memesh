import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('dashboard/src/components/GraphTab.tsx', 'utf8');
const start = source.indexOf('        if (showLabel) {');
const end = source.indexOf('\n      }\n\n      ctx.globalAlpha = 1;', start);
if (start < 0 || end <= start) throw new Error('Graph draw boundary changed; update the geometry replay');
const draw = new Script(source.slice(start, end));
const badgeRadius = Number(source.match(/const BADGE_R = (\d+);/)?.[1]);

describe('graph evidence badge geometry', () => {
  for (const scale of [0.35, 0.5, 1, 2, 3]) for (const radius of [3.5, 9, 10]) {
    it(`keeps the badge left of its node and label at scale ${scale}, radius ${radius}`, () => {
      let badge: { x: number; y: number; radius: number } | undefined;
      const ctx = {
        strokeText() {}, beginPath() {}, stroke() {}, fill() {}, fillText() {},
        arc(x: number, y: number, radius: number) { badge = { x, y, radius }; },
      };
      const node = { x: 100, y: 100, display: 'Node title', evidenceCount: 12, badge: null };
      draw.runInNewContext({ ctx, vp: { scale }, n: node, r: radius,
        isHovered: false, matched: false, isFocusCenter: false, tk: {},
        ellipsize: (text: string) => text, alpha: 1, BADGE_R: badgeRadius, showLabel: true,
      }, { timeout: 1000 });
      expect(badge).toBeDefined();
      expect(badge!.x + badge!.radius).toBeLessThan(node.x - radius);
      expect(node.badge).toEqual({ x: badge!.x, y: badge!.y });
    });
  }
});
