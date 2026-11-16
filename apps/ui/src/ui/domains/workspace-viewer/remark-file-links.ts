/**
 * Turns the file paths an agent writes as plain text or `inline code` into links, and a web address
 * written as `inline code` too, so the chat can open them. Markdown links and bare web addresses are
 * links already (GFM); code blocks are left as written.
 */

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

/**
 * A path with at least one folder and a file name with an extension, optionally `:line` or
 * `:line:column`: `src/a.ts`, `./docs/b.md:12`, `/tmp/x/shot.png`, `~/notes/c.txt`. Not glued to
 * a word or another path on its left, so `and/or`, `1/2` and the tail of a URL stay text.
 */
const PATH_SOURCE =
  String.raw`(?:~|\.{1,2})?\/?(?:[\w@+~-](?:[\w@.+~-]*[\w@+~-])?\/)+[\w@+~-][\w@.+~-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?:[:-]\d+)?)?`;
const PATH_IN_TEXT = new RegExp(String.raw`(?<![\w@.~/:-])${PATH_SOURCE}(?![\w/])`, 'g');
const WHOLE_PATH = new RegExp(String.raw`^${PATH_SOURCE}$`);
const WEB_ADDRESS = /^https?:\/\/[^\s<>"'`]+$/i;

/** Whether `text` is a file path as the chat links them. */
export function isFilePath(text: string): boolean {
  return WHOLE_PATH.test(text);
}

const LEAVE_ALONE = new Set(['link', 'linkReference', 'definition', 'code', 'html', 'image', 'imageReference']);

function link(url: string, child: MarkdownNode): MarkdownNode {
  return { type: 'link', url, children: [child] };
}

function splitText(value: string): MarkdownNode[] | undefined {
  const pieces: MarkdownNode[] = [];
  let at = 0;
  for (const match of value.matchAll(PATH_IN_TEXT)) {
    const start = match.index;
    if (start > at) pieces.push({ type: 'text', value: value.slice(at, start) });
    pieces.push(link(match[0], { type: 'text', value: match[0] }));
    at = start + match[0].length;
  }
  if (pieces.length === 0) return undefined;
  if (at < value.length) pieces.push({ type: 'text', value: value.slice(at) });
  return pieces;
}

function linkify(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap(child => {
    if (LEAVE_ALONE.has(child.type)) return [child];
    if (child.type === 'inlineCode') {
      const code = child.value?.trim() ?? '';
      return WEB_ADDRESS.test(code) || isFilePath(code) ? [link(code, child)] : [child];
    }
    if (child.type === 'text') return splitText(child.value ?? '') ?? [child];
    linkify(child);
    return [child];
  });
}

/** The remark plugin. Stable: pass the same array every render. */
export function remarkFileLinks() {
  return (tree: MarkdownNode) => linkify(tree);
}

export const FILE_LINK_PLUGINS = [remarkFileLinks];
