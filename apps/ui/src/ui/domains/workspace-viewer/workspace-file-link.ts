/**
 * Links an agent writes to files in its own workspace, as the Files panel names them: a path relative to
 * the session's workspace root (`syncta-docs/changes/…/requirements.md`). Agents also write `./` prefixes,
 * `#anchor` or `:line` suffixes, and absolute sandbox paths whose root the browser cannot know; those are
 * trimmed to the part below the card or session folder.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `:42`, `:42:7` and a range `:262-275`. */
const LINE_SUFFIX = /:\d+(?:[:-]\d+)?$/;
/** A sandbox root segment an absolute path passes through before the workspace begins. */
const WORKSPACE_ROOT_SEGMENT = /^(?:factory-item-[^/]+|session-[^/]+)$/;

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * The workspace-relative path a link points at, or undefined when it is not a workspace file:
 * a URL with a scheme, a bare `#anchor`, a protocol-relative `//host`, a path climbing out with `..`,
 * or an absolute path that does not run through a known workspace root.
 */
export function workspaceFilePath(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const raw = href.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || SCHEME.test(raw)) return undefined;
  let path = decode(raw.split(/[?#]/, 1)[0]!).replace(LINE_SUFFIX, '');
  if (path.startsWith('/')) {
    const segments = path.split('/').filter(Boolean);
    const root = segments.findIndex(segment => WORKSPACE_ROOT_SEGMENT.test(segment));
    if (root === -1) return undefined;
    path = segments.slice(root + 1).join('/');
  }
  path = path.replace(/^(?:\.\/)+/, '');
  const segments = path.split('/').filter(segment => segment && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return segments.join('/');
}

/** The Product documents a hand-off links, by their file name under a change folder. */
export type ProductDocumentKind = 'research' | 'brief' | 'spec' | 'tasks';

export interface ProductDocument {
  path: string;
  kind: ProductDocumentKind;
  /** The language of a copy in another language, e.g. `en` for the brief in the client's (`requirements.en.md`). */
  language?: string;
}

const PRODUCT_DOCUMENTS: Record<string, ProductDocumentKind> = {
  research: 'research',
  requirements: 'brief',
  design: 'spec',
  tasks: 'tasks',
};

const PRODUCT_DOCUMENT_PATH =
  /(?:^|\/)changes\/(?:archive\/)?[^/]+\/(research|requirements|design|tasks)(?:\.([a-z]{2}(?:-[a-z]{2})?))?\.md$/i;

/** Which Product document a workspace path is, when it sits in a `changes/<change>/` folder. */
export function productDocument(path: string): ProductDocument | undefined {
  const match = PRODUCT_DOCUMENT_PATH.exec(path);
  if (!match) return undefined;
  const kind = PRODUCT_DOCUMENTS[match[1]!.toLowerCase()]!;
  return match[2] ? { path, kind, language: match[2].toLowerCase() } : { path, kind };
}

/** Markdown link targets in a message, in order, without duplicates. */
export function markdownLinkTargets(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.add(match[1]!);
  return [...targets];
}

/** The Product documents a message links, each once, in the order linked. */
export function linkedProductDocuments(text: string): ProductDocument[] {
  const seen = new Set<string>();
  return markdownLinkTargets(text).flatMap(target => {
    const path = workspaceFilePath(target);
    const document = path ? productDocument(path) : undefined;
    if (!document || seen.has(document.path)) return [];
    seen.add(document.path);
    return [document];
  });
}
