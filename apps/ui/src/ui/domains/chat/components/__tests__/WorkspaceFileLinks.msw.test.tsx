import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { WorkspacePanelContext } from '../../../workspace-viewer/context/WorkspacePanelContext';
import type { WorkspacePanelApi } from '../../../workspace-viewer/context/WorkspacePanelContext';
import { useWorkspaceFileLinkComponents, WorkspaceDocumentButtons } from '../WorkspaceFileLinks';

const HANDOFF =
  'Бриф готовий: [Бриф (UK)](syncta-docs/changes/2026-11-10-n/requirements.md) і ' +
  '[Brief (EN)](syncta-docs/changes/2026-11-10-n/requirements.en.md). MR: [#12](https://github.com/Eclipt-AI/syncta-docs/pull/12).';

function panel(openFile: WorkspacePanelApi['openFile']): WorkspacePanelApi {
  return {
    open: false,
    setOpen: () => {},
    workspacePath: 'session-1',
    threadId: 'thread-1',
    size: 'compact',
    setSize: () => {},
    canDock: true,
    readsChanges: false,
    openFile,
  };
}

function Reply({ text }: { text: string }) {
  const components = useWorkspaceFileLinkComponents();
  return (
    <>
      <MarkdownRenderer components={components}>{text}</MarkdownRenderer>
      <WorkspaceDocumentButtons text={text} />
    </>
  );
}

describe('workspace file links in the chat', () => {
  it('opens a linked workspace file in the Files panel instead of navigating', async () => {
    const openFile = vi.fn();
    renderWithProviders(
      <WorkspacePanelContext.Provider value={panel(openFile)}>
        <Reply text={HANDOFF} />
      </WorkspacePanelContext.Provider>,
    );

    await userEvent.click(screen.getByRole('link', { name: 'Open requirements.md in the Files panel' }));
    expect(openFile).toHaveBeenCalledWith('syncta-docs/changes/2026-11-10-n/requirements.md');

    // A web link is untouched: it still opens in a new tab.
    const mr = screen.getByRole('link', { name: '#12' });
    expect(mr).toHaveAttribute('href', 'https://github.com/Eclipt-AI/syncta-docs/pull/12');
    expect(mr).toHaveAttribute('target', '_blank');
  });

  it('draws one button per linked document, naming the language of each brief', async () => {
    const openFile = vi.fn();
    renderWithProviders(
      <WorkspacePanelContext.Provider value={panel(openFile)}>
        <Reply text={HANDOFF} />
      </WorkspacePanelContext.Provider>,
    );

    const group = screen.getByRole('group', { name: 'Documents to review' });
    expect(group).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open brief (EN)' }));
    expect(openFile).toHaveBeenCalledWith('syncta-docs/changes/2026-11-10-n/requirements.en.md');
    // The team's copy is in the UI's language; here that is English too, so it goes unlabelled.
    await userEvent.click(screen.getByRole('button', { name: 'Open brief' }));
    expect(openFile).toHaveBeenCalledWith('syncta-docs/changes/2026-11-10-n/requirements.md');
  });

  it('leaves links and draws no buttons outside a session with a Files panel', () => {
    renderWithProviders(<Reply text={HANDOFF} />);

    expect(screen.queryByRole('group', { name: 'Documents to review' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Бриф (UK)' })).toHaveAttribute(
      'href',
      'syncta-docs/changes/2026-11-10-n/requirements.md',
    );
  });
});
