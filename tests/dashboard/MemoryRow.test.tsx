// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { MemoryRow } from '../../dashboard/src/components/MemoryRow';
import { SeverityBadge, parseStructuredBlocks } from '../../dashboard/src/components/LessonCards';
import { setLocale } from '../../dashboard/src/lib/i18n';
import type { Entity } from '../../dashboard/src/lib/api';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 1,
    name: 'auth-decision',
    type: 'decision',
    created_at: '2026-04-15T00:00:00.000Z',
    observations: ['Use OAuth 2.0 with PKCE for browser flows'],
    tags: ['project:memesh', 'topic:auth'],
    ...overrides,
  };
}

describe('MemoryRow', () => {
  it('renders the best observation as the headline when no title exists', () => {
    const { container } = render(<MemoryRow entity={makeEntity()} />);
    expect(container.textContent).toContain('Use OAuth 2.0 with PKCE');
    // UX-1: the machine key must NOT be visible row text — it is a dedup
    // key, not a label. Exact identity lives in expanded technical details,
    // so it must not replace the readable accessible name via a tooltip.
    expect(container.textContent).not.toContain('auth-decision');
    expect(container.querySelector('.mem-preview')?.getAttribute('title')).toBeNull();
  });

  it('prefers the human title as the headline when present', () => {
    const e = makeEntity({ title: 'Adopt OAuth 2.0 with PKCE' });
    const { container } = render(<MemoryRow entity={e} />);
    const headline = container.querySelector('.mem-preview');
    expect(headline?.textContent).toContain('Adopt OAuth 2.0 with PKCE');
    // The observation is no longer the headline once a title exists
    expect(headline?.textContent).not.toContain('Use OAuth 2.0 with PKCE');
  });

  it('never uses the machine name as headline even with no title and no observations', () => {
    const e = makeEntity({ observations: [] });
    const { container } = render(<MemoryRow entity={e} />);
    const headline = container.querySelector('.mem-preview')?.textContent ?? '';
    expect(headline).not.toContain('auth-decision');
    // Fallback chain lands on typeLabel + date
    expect(headline).toContain('Decision');
  });

  it('shows the project chip when a project: tag is present', () => {
    const { container } = render(<MemoryRow entity={makeEntity()} />);
    // Post-SPEC-5 the folder glyph is an SVG, not an emoji. Locate the
    // chip by its tag class plus the project name text.
    const chips = Array.from(container.querySelectorAll('.tag'));
    const projectChip = chips.find((c) => (c.textContent ?? '').includes('memesh'));
    expect(projectChip).toBeDefined();
    expect(projectChip!.querySelector('svg')).not.toBeNull();
  });

  it('omits the recall badge when access_count is 0', () => {
    const e = makeEntity({ access_count: 0 });
    const { container } = render(<MemoryRow entity={e} />);
    expect(container.textContent).not.toMatch(/次回憶|recalls/);
  });

  it('shows a high-tone badge when access_count >= 20', () => {
    const e = makeEntity({ access_count: 42 });
    const { container } = render(<MemoryRow entity={e} />);
    // Both Chinese and English fallback labels include the count
    expect(container.textContent).toMatch(/42/);
  });

  it('localises the type badge through the type.* catalogue', () => {
    // The badge used to print the raw slug (`decision`) — hardcoded English
    // for every non-English user. It must go through typeLabel(): localised
    // for known types, raw slug only as the sanctioned fallback.
    setLocale('zh-TW');
    try {
      const zh = render(<MemoryRow entity={makeEntity({ type: 'decision' })} />);
      expect(zh.container.querySelector('.badge-type')?.textContent).toBe('決策');
    } finally {
      setLocale('en');
    }
    const en = render(<MemoryRow entity={makeEntity({ type: 'decision' })} />);
    expect(en.container.querySelector('.badge-type')?.textContent).toBe('Decision');
    // Unknown type: raw slug, not a dotted i18n key.
    const unknown = render(<MemoryRow entity={makeEntity({ type: 'custom_thing' })} />);
    expect(unknown.container.querySelector('.badge-type')?.textContent).toBe('custom_thing');
  });

  it('does not surface internal date or project: tags in the tag row', () => {
    const e = makeEntity({ tags: ['project:memesh', '2026-04-15', 'topic:auth'] });
    const { container } = render(<MemoryRow entity={e} />);
    // project:memesh becomes the dedicated chip, not a generic tag
    const tagChips = Array.from(container.querySelectorAll('.tag')).map((el) => el.textContent ?? '');
    expect(tagChips.some((t) => t.includes('topic:auth'))).toBe(true);
    // Date-stamp tag and project: prefix should not appear as raw tag chips
    expect(tagChips.some((t) => /^2026-04-15$/.test(t.trim()))).toBe(false);
  });

  it('uses the dedicated SVG icon (not emoji) for known types', () => {
    // After SPEC-5 the icon column renders an SVG. The accessible name is
    // the localised label of the ACTUAL type (type.* catalogue keys) — a
    // release is announced as "Release", not as its glyph cluster
    // ("Feature") the way the retired English TITLES map did.
    const lesson = render(<MemoryRow entity={makeEntity({ type: 'lesson_learned' })} />);
    const lessonSvg = lesson.container.querySelector('svg[aria-label="Lesson"]');
    expect(lessonSvg).not.toBeNull();

    const bug = render(<MemoryRow entity={makeEntity({ type: 'bug_fix' })} />);
    expect(bug.container.querySelector('svg[aria-label="Bug fix"]')).not.toBeNull();

    const release = render(<MemoryRow entity={makeEntity({ type: 'release' })} />);
    expect(release.container.querySelector('svg[aria-label="Release"]')).not.toBeNull();
  });

  it('does not render any emoji as a UI affordance (DESIGN.md mandate)', () => {
    const { container } = render(<MemoryRow entity={makeEntity({ type: 'lesson_learned' })} />);
    // Match the historical type-glyph emoji as alternation, not as a
    // character class. Several glyphs (♻️, 🗺️, ⏱️, 🏗️, ⚙️) carry the
    // U+FE0F variation selector, which would appear repeated inside a
    // single [...] class — flagged by `js/regex/duplicate-in-character-class`.
    // SDD plan SPEC-5 AC1: no emoji in component-rendered DOM.
    const TYPE_GLYPHS = /💡|🎯|🐛|🧩|✨|♻️|📝|📋|🗺️|📓|🚀|⏱️|📅|🔖|🏗️|⚙️|📚/;
    expect(container.textContent ?? '').not.toMatch(TYPE_GLYPHS);
  });
});

describe('MemoryRow text handling', () => {
  it('highlights the characters that matched even when lower-casing changes the text length', () => {
    // 'İ'.toLowerCase() is two code units, so an index found in the lower-cased
    // copy pointed one character too far into the original.
    const { container } = render(<MemoryRow entity={makeEntity({ title: 'İstanbul notes' })} highlight="stanbul" />);
    expect(container.querySelector('mark')?.textContent).toBe('stanbul');
  });

  it('truncates a long headline without splitting an emoji in two', () => {
    const title = `${'a'.repeat(159)}😀 tail`;
    const { container } = render(<MemoryRow entity={makeEntity({ title })} />);
    const text = container.querySelector('.mem-preview')?.textContent ?? '';
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('lesson bodies and badges', () => {
  it('keeps every line of a failure lesson: repeated fixes are joined, unknown lines are shown', () => {
    const [block] = parseStructuredBlocks([
      'Error: boom', 'Root cause: r', 'Solution 1: try A', 'Solution 2: try B',
      'Prevention: p', 'Context: seen on CI only',
    ]);
    expect(block.fix).toBe('try A\ntry B');
    expect(block.extra).toEqual(['Context: seen on CI only']);
  });

  it('colours a severity badge with its -soft token (a hex suffix on var() is not a colour)', () => {
    const { container } = render(<SeverityBadge entity={makeEntity({ tags: ['severity:critical'] })} />);
    const style = container.querySelector('.badge')!.getAttribute('style') ?? '';
    expect(style).toContain('var(--danger-soft)');
    expect(style).not.toMatch(/\)18/);
  });
});
