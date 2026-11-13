/**
 * Which lines of a markdown file a passage selected in its rendered view came from, so a note can tell the
 * agent `requirements.md:262-275` and not only quote text it would have to search for.
 *
 * The rendered text drops markdown's syntax (list numbers, heading marks, link targets, fence lines), so
 * both sides are compared by their letters and digits alone, with each source character keeping its line.
 * A passage that crosses something the renderer adds or reshapes (a code block's label, a table) is placed
 * by its first and last words instead.
 */

export interface LineRange {
  start: number;
  end: number;
}

const SIGNIFICANT = /[\p{L}\p{N}]/u;
/** Block markers drawn as structure, not text: quotes, headings, list bullets and numbers, task boxes. */
const BLOCK_MARKERS = /^\s*(?:>\s*)*(?:#{1,6}\s+|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)?/;
const FENCE = /^\s*(?:```|~~~)/;
/** Inline link and image targets: the text in brackets shows, the target does not. */
const LINK_TARGET = /\]\([^)]*\)/g;
const HTML_COMMENT = /<!--.*?-->/g;
/** Long enough that a passage's first or last words are rarely repeated elsewhere. */
const EDGE = 24;

const significant = (text: string) => Array.from(text).filter(char => SIGNIFICANT.test(char)).join('');

function indexSource(source: string): { text: string; lines: number[] } {
  let text = '';
  const lines: number[] = [];
  source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, index) => {
      if (FENCE.test(raw)) return;
      const shown = significant(raw.replace(BLOCK_MARKERS, '').replace(LINK_TARGET, ']').replace(HTML_COMMENT, ''));
      text += shown;
      for (let i = 0; i < shown.length; i += 1) lines.push(index + 1);
    });
  return { text, lines };
}

function occurrences(text: string, part: string, from = 0): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(part, from); at !== -1; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
}

/** Of several copies, the one whose preceding text matches what preceded the selection, else the first. */
function pick(text: string, copies: number[], before: string): number | undefined {
  if (copies.length <= 1 || !before) return copies[0];
  return copies.find(at => text.slice(Math.max(0, at - before.length), at).endsWith(before)) ?? copies[0];
}

/** The 1-based lines a passage spans, or undefined when it cannot be placed in the source. */
export function passageLines(source: string, passage: string, textBefore = ''): LineRange | undefined {
  const wanted = significant(passage);
  if (!wanted) return undefined;
  const { text, lines } = indexSource(source);
  const before = significant(textBefore);
  const whole = pick(text, occurrences(text, wanted), before);
  if (whole !== undefined) return { start: lines[whole]!, end: lines[whole + wanted.length - 1]! };

  const head = pick(text, occurrences(text, wanted.slice(0, EDGE)), before);
  if (head === undefined) return undefined;
  const tailPart = wanted.slice(-EDGE);
  const tail = occurrences(text, tailPart, head)[0];
  if (tail === undefined) return undefined;
  return { start: lines[head]!, end: lines[tail + tailPart.length - 1]! };
}

/** `path:262-275`, or `path:262` for one line. */
export function lineLabel(path: string, range: LineRange): string {
  return range.start === range.end ? `${path}:${range.start}` : `${path}:${range.start}-${range.end}`;
}

/**
 * A Markdown link to the passage the agent reads as `path:262-275` and the Files panel opens on a click.
 * Without lines it still links the file.
 */
export function passageLink(path: string, range: LineRange | undefined): string {
  const href = encodeURI(path);
  if (!range) return `[${path}](${href})`;
  const anchor = range.start === range.end ? `#L${range.start}` : `#L${range.start}-L${range.end}`;
  return `[${lineLabel(path, range)}](${href}${anchor})`;
}
