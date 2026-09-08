// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { ProjectRoadmap } from '../../dashboard/src/components/ProjectRoadmap';
import type { Entity } from '../../dashboard/src/lib/api';

function rows(phases: number): Entity[] {
  return Array.from({ length: phases * 3 }, (_, i) => ({
    id: i + 1, name: `entity-${i}`, title: `Entity ${i}`, type: i % 3 === 0 ? 'release' : 'pattern',
    created_at: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 3) * 14 + i % 3)).toISOString(),
    observations: ['fixture'], tags: [],
  }));
}

it.each([1, 4])('anchors wheel zoom after live phase count becomes %i', async (phaseCount) => {
  const { container, rerender } = render(<ProjectRoadmap projectName="fixture" entities={rows(1)} />);
  const tab = [...container.querySelectorAll('[role="tab"]')].find(x => /Mindmap/.test(x.textContent ?? ''))!;
  fireEvent.click(tab);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  const svg = container.querySelector('svg[height="600"]')!;
  Object.defineProperty(svg, 'getBoundingClientRect', { value: () => ({
    left: 0, top: 0, width: Number(svg.getAttribute('width')), height: 600,
  }) });
  rerender(<ProjectRoadmap projectName="fixture" entities={rows(phaseCount)} />);
  expect(svg.getAttribute('width')).toBe(String(Math.max(900, phaseCount * 360)));
  const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
  Object.defineProperties(wheel, { clientX: { value: 720 }, clientY: { value: 300 } });
  fireEvent(svg, wheel);
  const transform = svg.querySelector(':scope > g')!.getAttribute('transform')!;
  const [panX, , scale] = transform.match(/-?[\d.]+/g)!.map(Number);
  expect(panX / (1 - scale)).toBeCloseTo(720, 6);
});
