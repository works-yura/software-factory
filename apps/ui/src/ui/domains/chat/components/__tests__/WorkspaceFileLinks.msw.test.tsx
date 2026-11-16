import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { WorkspacePanelContext } from '../../../workspace-viewer/context/WorkspacePanelContext';
import type { WorkspacePanelApi } from '../../../workspace-viewer/context/WorkspacePanelContext';
import { useWorkspaceFileLinkComponents, useWorkspaceFileLinkPlugins, WorkspaceDocumentButtons } from '../WorkspaceFileLinks';

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
  const plugins = useWorkspaceFileLinkPlugins();
  return (
    <>
      <MarkdownRenderer components={components} remarkPlugins={plugins}>
        {text}
      </MarkdownRenderer>
      <WorkspaceDocumentButtons text={text} />
    </>
  );
}

describe('workspace file links in the chat', () => {
  it('opens a menu on a workspace file link, whose first item opens it in the Files panel', async () => {
    const openFile = vi.fn();
    renderWithProviders(
      <WorkspacePanelContext.Provider value={panel(openFile)}>
        <Reply text={HANDOFF} />
      </WorkspacePanelContext.Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open requirements.md in the Files panel' }));
    expect(openFile).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('menuitem', { name: /Open in the Files panel/ }));
    expect(openFile).toHaveBeenCalledWith('syncta-docs/changes/2026-11-10-n/requirements.md');
  });

  it('opens a file at once on a ⌘-click, without the menu', async () => {
    const openFile = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <WorkspacePanelContext.Provider value={panel(openFile)}>
        <Reply text={HANDOFF} />
      </WorkspacePanelContext.Provider>,
    );

    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: 'Open requirements.md in the Files panel' }));
    await user.keyboard('{/Meta}');
    expect(openFile).toHaveBeenCalledWith('syncta-docs/changes/2026-11-10-n/requirements.md');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('turns paths written as text or code into links, and keeps a server path to copying', async () => {
    const openFile = vi.fn();
    renderWithProviders(
      <WorkspacePanelContext.Provider value={panel(openFile)}>
        <Reply text={'Fixed `src/agent.ts` and docs/plan.md:12. Log: /private/tmp/run/out.txt'} />
      </WorkspacePanelContext.Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open plan.md in the Files panel' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Open in the Files panel/ }));
    expect(openFile).toHaveBeenCalledWith('docs/plan.md');

    await userEvent.click(screen.getByRole('button', { name: 'Open agent.ts in the Files panel' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Open in the Files panel/ }));
    expect(openFile).toHaveBeenCalledWith('src/agent.ts');

    await userEvent.click(screen.getByRole('button', { name: 'Path out.txt outside the workspace' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Open/ })).toBeNull();
  });

  it('opens a build in the session sandbox by its absolute path, and offers it for download', async () => {
    const openFile = vi.fn();
    const apk = '/srv/factory/sandboxes/083d7b63/biod/build/app/outputs/flutter-apk/app-release.apk';
    renderWithProviders(
      <WorkspacePanelContext.Provider value={panel(openFile)}>
        <Reply text={`APK: \`${apk}\``} />
      </WorkspacePanelContext.Provider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open app-release.apk in the Files panel' }));
    const download = await screen.findByRole('menuitem', { name: 'Download' });
    expect(download).toHaveAttribute('href', expect.stringContaining('/web/workspace/file/download?'));
    expect(new URL(download.getAttribute('href')!, 'http://x').searchParams.get('path')).toBe(apk);
    expect(download).toHaveAttribute('download', 'app-release.apk');
    await userEvent.click(screen.getByRole('menuitem', { name: /Open in the Files panel/ }));
    expect(openFile).toHaveBeenCalledWith(apk);
  });

  it('offers a web link a new tab and a copy instead of navigating on a click', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWithProviders(
      <WorkspacePanelContext.Provider value={panel(vi.fn())}>
        <Reply text={HANDOFF} />
      </WorkspacePanelContext.Provider>,
    );

    const mr = screen.getByRole('button', { name: 'Link https://github.com/Eclipt-AI/syncta-docs/pull/12' });
    expect(mr).toHaveAttribute('href', 'https://github.com/Eclipt-AI/syncta-docs/pull/12');
    await userEvent.click(mr);
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Open in a new tab/ }));
    expect(open).toHaveBeenCalledWith('https://github.com/Eclipt-AI/syncta-docs/pull/12', '_blank', 'noopener,noreferrer');
    open.mockRestore();
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
