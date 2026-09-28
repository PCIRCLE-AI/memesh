// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Chip } from '../../dashboard/src/components/Chip';

// #493: `projectChipLabels` (entity-display.test.ts) proves the MAP is
// right; this proves the component actually RENDERS what the map hands it —
// the `idSuffix` mono span has no coverage anywhere else, since the smoke
// test's two seeded projects never share a label (no suffix is ever
// produced in that run).
describe('Chip — #493 project-id disambiguator + tooltip', () => {
  it('renders label + idSuffix as one string, with the suffix in --mono', () => {
    const { container } = render(
      <Chip label="memesh" idSuffix="2c0fe4" active={false} onClick={() => {}} />,
    );
    expect(container.textContent).toContain('memesh~2c0fe4');
    const suffixEl = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === '~2c0fe4',
    );
    expect(suffixEl?.style.fontFamily).toBe('var(--mono)');
  });

  it('renders no suffix text when idSuffix is not given', () => {
    const { container } = render(
      <Chip label="memesh-llm-memory" active={false} onClick={() => {}} />,
    );
    expect(container.textContent).toBe('memesh-llm-memory');
  });

  it('puts the full id in the button title, separate from the visible label', () => {
    const fullId = 'memesh~2c0fe491888c8efb9a4894828bbc2733';
    const { container } = render(
      <Chip label="memesh" idSuffix="2c0fe4" title={fullId} active={false} onClick={() => {}} />,
    );
    const button = container.querySelector('button');
    expect(button?.getAttribute('title')).toBe(fullId);
    // The accessible name stays the visible label/count, not the raw id —
    // `title` is a tooltip/description, not a replacement (no aria-label).
    expect(button?.getAttribute('aria-label')).toBeNull();
  });

  it('keeps the count in --mono and reachable in the accessible name', () => {
    const { container } = render(
      <Chip label="memesh" count={353} active={false} onClick={() => {}} />,
    );
    expect(container.textContent).toBe('memesh353');
  });
});
