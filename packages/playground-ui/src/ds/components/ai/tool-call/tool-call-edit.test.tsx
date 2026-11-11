// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ToolCallEdit, unifiedDiffLines } from './tool-call-edit';

afterEach(cleanup);

describe('ToolCallEdit', () => {
  it('shows a replacement as its removed lines then its added lines, bounded', () => {
    const newText = Array.from({ length: 201 }, (_, index) => `line ${index}`).join('\n');
    const { container } = render(<ToolCallEdit edit={{ path: 'a.ts', oldText: 'old', newText }} />);

    const rows = container.querySelectorAll('[role="group"] > div');
    expect(rows[0]?.textContent).toBe('-old');
    expect(rows[1]?.textContent).toBe('+line 0');
    expect(screen.getByText('… 1 more lines')).toBeTruthy();
  });

  it('draws a unified diff with its context, hunks and both sides, without file headers', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@', ' keep', '-old', '+new', ' tail'].join('\n');
    const { container } = render(<ToolCallEdit edit={{ path: 'a.ts', diff }} />);
    const rows = [...container.querySelectorAll('[role="group"] > div')].map(row => row.textContent);
    expect(rows).toEqual(['@@ -1,3 +1,3 @@', ' keep', '-old', '+new', ' tail']);
    expect(container.querySelector('[data-diff-line="removed"]')?.className).toContain('bg-destructive-subtle');
    expect(container.querySelector('[data-diff-line="added"]')?.className).toContain('bg-success-subtle');
    expect(unifiedDiffLines('\\ No newline at end of file\n+x')).toEqual([{ kind: 'added', text: 'x' }]);
  });

  it('keeps every changed line available when reviewing an approval', () => {
    const newText = Array.from({ length: 205 }, (_, index) => `line ${index}`).join('\n');
    render(<ToolCallEdit edit={{ path: 'a.ts', oldText: 'old', newText }} showFullContent />);

    expect(screen.getByText('line 204')).toBeTruthy();
    expect(screen.queryByText(/more lines/)).toBeNull();
  });

  it('colors both sides for the file type once highlighting lands', async () => {
    const { container } = render(
      <ToolCallEdit edit={{ path: 'a.ts', oldText: 'const a = 1', newText: 'const a = 2\nconst b = 3' }} />,
    );

    const rows = () => container.querySelectorAll('[role="group"] > div');
    await waitFor(
      () => {
        expect(rows()[0]?.querySelectorAll('[class^="syntax-"]').length).toBeGreaterThan(1);
        expect(rows()[2]?.querySelectorAll('[class^="syntax-"]').length).toBeGreaterThan(1);
      },
      { timeout: 5000 },
    );
    expect(rows()[0]?.textContent).toBe('-const a = 1');
    expect(rows()[2]?.textContent).toBe('+const b = 3');
  });

  it('shows a written file as its content', () => {
    render(<ToolCallEdit edit={{ path: 'notes.md', content: '# hello' }} />);

    expect(screen.getByText('# hello')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'File change' })).toBeNull();
  });
});
