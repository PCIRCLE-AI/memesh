/**
 * Error text that is dropped into a sentence of ours ends with our own full
 * stop. When the text already ends with one (MeMesh's own messages do), the
 * result printed `..`; trim it so the template's stop is the only one.
 */
export function withoutFinalPeriod(text: string): string {
  return text.replace(/\.\s*$/, '');
}
