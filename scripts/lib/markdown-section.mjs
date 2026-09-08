/**
 * Return one Markdown section, bounded by the next heading of the same or a
 * higher level. The heading text is matched exactly so a claim moved to an
 * unrelated section cannot satisfy a release gate.
 */
export function markdownSection(document, heading) {
  const lines = document.split('\n');
  const start = lines.findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    return match?.[2] === heading;
  });
  if (start === -1) return null;

  const level = lines[start].match(/^(#{1,6})/)?.[1].length;
  if (level === undefined) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#{1,6})\s+/);
    if (next && next[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}
