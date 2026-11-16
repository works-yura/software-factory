import { describe, expect, it } from 'vitest';

import { isFilePath, remarkFileLinks } from '../remark-file-links';

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

function paragraph(...children: Node[]): Node {
  return { type: 'root', children: [{ type: 'paragraph', children }] };
}

function run(tree: Node): Node[] {
  remarkFileLinks()(tree);
  return tree.children![0]!.children!;
}

const urls = (nodes: Node[]) => nodes.filter(node => node.type === 'link').map(node => node.url);

describe('remarkFileLinks', () => {
  it('links file paths written as text, keeping the words around them', () => {
    const nodes = run(
      paragraph({ type: 'text', value: 'Changed src/agent.ts:42 and ./docs/plan.md. Shot: /tmp/x/home.png, done' }),
    );
    expect(urls(nodes)).toEqual(['src/agent.ts:42', './docs/plan.md', '/tmp/x/home.png']);
    expect(nodes.map(node => node.value ?? node.children?.[0]?.value).join('')).toBe(
      'Changed src/agent.ts:42 and ./docs/plan.md. Shot: /tmp/x/home.png, done',
    );
  });

  it('leaves words with slashes, numbers and names without a folder as text', () => {
    const nodes = run(paragraph({ type: 'text', value: 'and/or 1/2 v4/apps package.json e.g./i.e 11/15/2026' }));
    expect(urls(nodes)).toEqual([]);
  });

  it('links a path or a web address written as inline code, and leaves other code alone', () => {
    const nodes = run(
      paragraph(
        { type: 'inlineCode', value: 'apps/ui/src/main.tsx' },
        { type: 'inlineCode', value: 'https://github.com/o/r/pull/1' },
        { type: 'inlineCode', value: 'npm test' },
      ),
    );
    expect(urls(nodes)).toEqual(['apps/ui/src/main.tsx', 'https://github.com/o/r/pull/1']);
    expect(nodes[0]!.children![0]!.type).toBe('inlineCode');
    expect(nodes[2]!.type).toBe('inlineCode');
  });

  it('does not touch links, their text, or code blocks', () => {
    const tree: Node = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'link', url: 'https://x.dev/a/b.md', children: [{ type: 'text', value: 'https://x.dev/a/b.md' }] }] },
        { type: 'code', value: 'cat src/a.ts' },
      ],
    };
    remarkFileLinks()(tree);
    expect(tree.children![0]!.children![0]!.children).toEqual([{ type: 'text', value: 'https://x.dev/a/b.md' }]);
    expect(tree.children![1]).toEqual({ type: 'code', value: 'cat src/a.ts' });
  });

  it('knows a whole path', () => {
    expect(isFilePath('~/notes/a.txt')).toBe(true);
    expect(isFilePath('a.txt')).toBe(false);
    expect(isFilePath('src/a')).toBe(false);
  });
});
