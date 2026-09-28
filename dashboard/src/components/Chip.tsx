/**
 * The shared filter chip — DESIGN.md "Component patterns" is the contract:
 * token-only styling, `--life` border / `--life-soft` fill / `--life` text
 * when active, `aria-pressed` always. Extracted from BrowseTab's private
 * chip when the memory surfaces merged; every chip row in the dashboard
 * renders this one component so the active state cannot drift per tab.
 */
interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
  /** Optional species/cluster swatch shown before the label (composition
   *  bar legends). A colour value, e.g. from CATEGORICAL_TYPE_COLORS. */
  dot?: string;
  /** The untruncated value `label` stands in for (#493) — e.g. a project id
   *  with its routing hash stripped for display. Native `title`, so the
   *  chip's own visible text stays the accessible name and the full value
   *  is a supplementary tooltip/description, not a replacement for it. */
  title?: string;
  /** A short hex disambiguator rendered after `label` as `~<idSuffix>` in
   *  `--mono` (DESIGN.md: an id compared digit by digit is mono, same
   *  voice as `count`). Set only when `label` alone would collide with
   *  another chip in the same row (`projectChipLabels`, entity-display.ts). */
  idSuffix?: string;
}

export function Chip({ label, active, onClick, count, dot, title, idSuffix }: ChipProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={title}
      style={{
        padding: '4px 10px',
        borderRadius: 'var(--radius)',
        border: '1px solid',
        borderColor: active ? 'var(--life)' : 'var(--border)',
        background: active ? 'var(--life-soft)' : 'transparent',
        color: active ? 'var(--life)' : 'var(--text-2)',
        fontSize: 14,
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: 'var(--radius-hairline)', background: dot, flexShrink: 0 }}
        />
      )}
      {/* Truncate a label with no break opportunity (a hex hash, a long path)
          instead of widening the row (#493). `minWidth: 0` on this span and on
          the button overrides the flex-item default (content width) so the span
          can actually shrink. */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {label}
        {idSuffix && <span style={{ fontFamily: 'var(--mono)' }}>~{idSuffix}</span>}
      </span>
      {count !== undefined && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 14, flexShrink: 0 }}>
          {count}
        </span>
      )}
    </button>
  );
}
