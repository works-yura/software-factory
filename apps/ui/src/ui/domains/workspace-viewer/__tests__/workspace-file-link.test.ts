import { describe, expect, it } from 'vitest';

import { linkedProductDocuments, productDocument, workspaceFilePath } from '../workspace-file-link';

describe('workspaceFilePath', () => {
  it('keeps a workspace-relative path and trims ./, anchors and line suffixes', () => {
    expect(workspaceFilePath('syncta-docs/changes/2026-11-10-n/requirements.md')).toBe(
      'syncta-docs/changes/2026-11-10-n/requirements.md',
    );
    expect(workspaceFilePath('./syncta-docs/README.md#overview')).toBe('syncta-docs/README.md');
    expect(workspaceFilePath('syncta-back/functions/index.js:42')).toBe('syncta-back/functions/index.js');
    expect(workspaceFilePath('syncta-back/functions/index.js:42:7')).toBe('syncta-back/functions/index.js');
    expect(workspaceFilePath('syncta-docs/changes/x/requirements.md:262-275')).toBe('syncta-docs/changes/x/requirements.md');
    expect(workspaceFilePath('syncta-docs/changes/x/requirements.md#L262-L275')).toBe('syncta-docs/changes/x/requirements.md');
    expect(workspaceFilePath('docs/My%20File.md')).toBe('docs/My File.md');
  });

  it('turns an absolute sandbox path into the part below the card folder', () => {
    expect(
      workspaceFilePath(
        '/Volumes/dot/factory-sandboxes/work-items/7b24/factory-item-91cb7133/syncta-docs/changes/c/design.md',
      ),
    ).toBe('syncta-docs/changes/c/design.md');
  });

  it('leaves URLs, bare anchors, escapes and unknown absolute paths alone', () => {
    expect(workspaceFilePath('https://github.com/Eclipt-AI/syncta-docs/pull/12')).toBeUndefined();
    expect(workspaceFilePath('mailto:a@b.c')).toBeUndefined();
    expect(workspaceFilePath('#section')).toBeUndefined();
    expect(workspaceFilePath('//cdn.example.com/x.js')).toBeUndefined();
    expect(workspaceFilePath('../outside.md')).toBeUndefined();
    expect(workspaceFilePath('/etc/passwd')).toBeUndefined();
    expect(workspaceFilePath(undefined)).toBeUndefined();
  });
});

describe('productDocument', () => {
  it('names the Product documents of a change, and a copy in another language', () => {
    expect(productDocument('syncta-docs/changes/c/requirements.md')).toEqual({
      path: 'syncta-docs/changes/c/requirements.md',
      kind: 'brief',
    });
    expect(productDocument('syncta-docs/changes/c/requirements.en.md')?.language).toBe('en');
    expect(productDocument('changes/archive/c/tasks.md')?.kind).toBe('tasks');
    expect(productDocument('syncta-docs/features/a/design.md')).toBeUndefined();
    expect(productDocument('syncta-docs/changes/c/notes.md')).toBeUndefined();
  });

  it('lists each linked document once, in order', () => {
    const text =
      'Бриф: [UK](syncta-docs/changes/c/requirements.md), [EN](syncta-docs/changes/c/requirements.en.md), ' +
      'again [UK](syncta-docs/changes/c/requirements.md), MR [#3](https://github.com/x/y/pull/3).';
    expect(linkedProductDocuments(text).map(document => document.path)).toEqual([
      'syncta-docs/changes/c/requirements.md',
      'syncta-docs/changes/c/requirements.en.md',
    ]);
  });
});
