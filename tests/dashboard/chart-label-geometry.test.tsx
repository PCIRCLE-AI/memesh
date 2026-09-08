// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { KnowledgeRadar } from '../../dashboard/src/components/KnowledgeRadar';
import { drawTimeline, TIMELINE_AXIS_FONT_SIZE } from '../../dashboard/src/components/MemoryTimeline';
import { ProjectRoadmap } from '../../dashboard/src/components/ProjectRoadmap';
import type { Entity } from '../../dashboard/src/lib/api';

function entity(overrides: Partial<Entity>): Entity {
  return {
    id: 1,
    name: 'memory',
    type: 'decision',
    created_at: '2026-04-15T00:00:00.000Z',
    observations: ['test'],
    tags: [],
    ...overrides,
  };
}

function mindmapEntities(phaseCount: number, entitiesPerPhase: number): Entity[] {
  return Array.from({ length: phaseCount * entitiesPerPhase }, (_, i) => {
    const phase = Math.floor(i / entitiesPerPhase);
    const inPhase = i % entitiesPerPhase;
    const createdAt = new Date(Date.UTC(2026, 0, 1 + phase * 14 + inPhase)).toISOString();
    return entity({
      id: i + 1,
      title: `Phase ${phase + 1} leaf label ${inPhase + 1}`,
      type: inPhase === 0 ? 'release' : 'pattern',
      created_at: createdAt,
    });
  });
}

type Bounds = { left: number; top: number; right: number; bottom: number; text: string };

function textBounds(label: SVGTextElement): Bounds {
  const x = Number(label.getAttribute('x'));
  const y = Number(label.getAttribute('y'));
  const fontSize = Number(label.getAttribute('font-size') ?? label.getAttribute('fontSize') ?? 14);
  const lines = label.querySelectorAll('tspan').length
    ? [...label.querySelectorAll('tspan')].map((line) => line.textContent ?? '')
    : [label.textContent ?? ''];
  // A fixed-width bound for this Latin fixture, not a browser font metric.
  // Localized glyph widths and actual overlap need browser replay separately.
  const width = Math.max(...lines.map((line) => line.length * 8));
  const height = lines.length * (fontSize + 4);
  const anchor = label.getAttribute('text-anchor') ?? label.getAttribute('textAnchor') ?? 'start';
  const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x;
  return { left, top: y - fontSize, right: left + width, bottom: y - fontSize + height, text: lines.join(' ') };
}

function assertMindmapGeometry(phaseCount: number, entitiesPerPhase: number) {
  const { container } = render(<ProjectRoadmap projectName="mindmap" entities={mindmapEntities(phaseCount, entitiesPerPhase)} />);
  const mindmap = [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
    .find((tab) => /Mindmap|心智圖/i.test(tab.textContent ?? ''))!;
  fireEvent.click(mindmap);
  const svg = container.querySelector('svg[height="600"]')!;
  const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
  const labels = [...svg.querySelectorAll<SVGTextElement>('text')].map(textBounds);
  const leafSlots = [...svg.querySelectorAll<SVGTextElement>('text')].filter((label) =>
    (label.closest('[role="button"]') && !label.querySelector('tspan')) ||
    label.getAttribute('font-style') === 'italic' || label.getAttribute('fontStyle') === 'italic',
  );
  const expectedSlots = phaseCount * (Math.min(entitiesPerPhase, 6) + (entitiesPerPhase > 6 ? 1 : 0));

  expect(leafSlots).toHaveLength(expectedSlots);
  expect(svg.querySelectorAll('[role="button"]')).toHaveLength(phaseCount * (Math.min(entitiesPerPhase, 6) + 1));
  expect([...svg.querySelectorAll('[role="button"]')].every((node) => node.getAttribute('tabindex') === '0')).toBe(true);
  for (const label of labels) {
    expect(label.left, `${label.text} clips left`).toBeGreaterThanOrEqual(0);
    expect(label.top, `${label.text} clips top`).toBeGreaterThanOrEqual(0);
    expect(label.right, `${label.text} clips right`).toBeLessThanOrEqual(width);
    expect(label.bottom, `${label.text} clips bottom`).toBeLessThanOrEqual(height);
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i];
      const b = labels[j];
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
        `${a.text} overlaps ${b.text}`).toBe(true);
    }
  }
}

describe('chart label geometry', () => {
  it('keeps the radar at a 14px label scale and scrolls instead of shrinking it', () => {
    const { container } = render(<KnowledgeRadar data={[
      { axis: 'decisions', count: 1, types: [] },
      { axis: 'patterns', count: 2, types: [] },
    ]} />);
    const svg = container.querySelector('svg')!;

    expect(svg.getAttribute('width')).toBe('364');
    expect(svg.getAttribute('viewBox')).toBe('-72 0 364 220');
    expect(svg.parentElement?.style.overflowX).toBe('auto');
    expect([...svg.querySelectorAll('text')].map((label) => label.getAttribute('font-size'))).toEqual(['14', '14']);
    expect([...svg.querySelectorAll('text')].map((label) => label.getAttribute('text-anchor'))).toEqual(['middle', 'middle']);
  });

  it('keeps the roadmap map at its 1:1 label scale inside a horizontal scroll host', () => {
    const { container } = render(
      <ProjectRoadmap projectName="memesh" entities={[
        entity({ id: 1, title: 'Foundation release', type: 'release', created_at: '2026-04-17T08:00:00.000Z' }),
        entity({ id: 2, title: 'Pattern discovery', type: 'pattern', created_at: '2026-04-17T10:00:00.000Z' }),
        entity({ id: 3, title: 'Decision recorded', created_at: '2026-04-18T09:00:00.000Z' }),
      ]} />,
    );
    const mindmap = [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => /Mindmap|心智圖/i.test(tab.textContent ?? ''))!;
    fireEvent.click(mindmap);
    const map = container.querySelector('svg[viewBox="0 0 900 600"]')!;

    expect(map.getAttribute('width')).toBe('900');
    expect(map.getAttribute('height')).toBe('600');
    expect(map.parentElement?.style.overflowX).toBe('auto');
    expect([...map.querySelectorAll('text')].map((label) => label.getAttribute('font-size'))).toEqual(['14', '14', '14', '14', '14']);
    expect(map.querySelector('text')?.getAttribute('text-anchor')).toBe('middle');
  });

  it('places leaves and the extra count in separate phase columns and rows', () => {
    assertMindmapGeometry(1, 7);
    assertMindmapGeometry(2, 7);
    assertMindmapGeometry(4, 7);
  });

  it('spaces 14px timeline dates inside a narrow canvas without dropping bars', () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      value: () => ({ width: 180, height: 120 }),
    });
    const labels: Array<{ text: string; x: number }> = [];
    const ctx = {
      scale: () => {}, fillRect: () => {}, beginPath: () => {}, moveTo: () => {},
      lineTo: () => {}, stroke: () => {}, measureText: () => ({ width: 36 }),
      fillText: (text: string, x: number) => labels.push({ text, x }),
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(canvas, 'getContext', { value: () => ctx });
    const data = Array.from({ length: 29 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      created: 1,
      recalled: 1,
    }));

    drawTimeline(canvas, data);

    expect(TIMELINE_AXIS_FONT_SIZE).toBe(14);
    expect(ctx.font).toContain('14px');
    expect(labels).toHaveLength(3);
    expect(labels.every(({ x }) => x - 18 >= 0 && x + 18 <= 180)).toBe(true);
  });
});
