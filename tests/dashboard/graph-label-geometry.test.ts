import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync('dashboard/src/components/GraphTab.tsx', 'utf8');
const start = source.indexOf('        if (showLabel) {');
const end = source.indexOf('\n      }\n\n      ctx.globalAlpha = 1;', start);
if (start < 0 || end <= start) throw new Error('Graph draw boundary changed; update the geometry replay');
const draw = new Script(source.slice(start, end));
const badgeRadius = Number(source.match(/const BADGE_R = (\d+);/)?.[1]);
const tooltipStart = source.indexOf('      if (tip.node && isNodeVisible(tip.node)) {');
const tooltipEnd = source.indexOf('\n\n      animRef.current', tooltipStart);
if (tooltipStart < 0 || tooltipEnd <= tooltipStart) throw new Error('Tooltip draw boundary changed');
const drawTooltip = new Script(ts.transpileModule(source.slice(tooltipStart, tooltipEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);

describe('graph tooltip canvas bounds', () => {
  for (const width of [338, 1028]) for (const edge of ['left', 'right', 'top', 'bottom']) {
    it(`keeps long text inside the ${width}px canvas at ${edge}`, () => {
      let box: number[] = [];
      const ctx = {
        setTransform() {}, beginPath() {}, fill() {}, stroke() {}, fillText() {},
        measureText(text: string) { return { width: text.length * 9 }; },
        roundRect(x: number, y: number, w: number, h: number) { box = [x, y, w, h]; },
      };
      drawTooltip.runInNewContext({ ctx, curDpr: 1,
        tip: { x: edge === 'left' ? 0 : width - 1, y: edge === 'top' ? 0 : 439,
          node: { display: 'A long readable node title '.repeat(10), type: 'decision', lastDate: '' } },
        isNodeVisible: () => true, typeLabel: () => 'Decision', formatAge: () => 'Recently',
        ellipsize: (text: string) => text, tk: {}, rgbaFrom: () => '',
        canvasWidthRef: { current: width }, CANVAS_HEIGHT: 440,
      }, { timeout: 1000 });
      expect(box).toHaveLength(4);
      expect(box[0]).toBeGreaterThanOrEqual(0);
      expect(box[1]).toBeGreaterThanOrEqual(0);
      expect(box[0] + box[2]).toBeLessThanOrEqual(width);
      expect(box[1] + box[3]).toBeLessThanOrEqual(440);
    });
  }
});

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
