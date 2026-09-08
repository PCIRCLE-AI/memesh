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
    expect([...svg.querySelectorAll('text')].map((label) => label.getAttribute('fontSize'))).toEqual(['14', '14']);
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
    expect([...map.querySelectorAll('text')].map((label) => label.getAttribute('fontSize'))).toEqual(['14', '14', '14', '14', '14']);
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
