import type { AssistantWorkspaceSlot } from '@factory/assistant-ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

import { queryKeys } from '../../../api/keys';
import { useWorkspaceFileLinkComponents, useWorkspaceFileLinkPlugins } from '../chat/components/WorkspaceFileLinks';
import { WorkspaceFilesSurface } from '../workspace-viewer/components/WorkspaceFilesSurface';
import { WorkspaceFilesToggle } from '../workspace-viewer/components/WorkspaceFilesToggle';
import { WorkspaceViewerPanel } from '../workspace-viewer/components/WorkspaceViewerPanel';
import { WorkspaceFilesEndpointsContext } from '../workspace-viewer/context/WorkspaceFilesEndpoints';
import type { WorkspaceFilesEndpoints } from '../workspace-viewer/context/WorkspaceFilesEndpoints';
import { WorkspaceFilesPanelProvider } from '../workspace-viewer/context/WorkspaceFilesProvider';
import { useWorkspacePanel } from '../workspace-viewer/context/useWorkspacePanel';

/** What the Files panel keys a request's folder by (the server's `workspaceViewPath`); never a path on disk. */
export function assistantWorkspacePath(requestId: string): string {
  return `assistant/${requestId}`;
}

/**
 * The request's folder at the assistant's routes, which answer in a session's Files shapes
 * (`WorkspaceTreeListing`, `WorkspaceFile`), so the sessions' tree, viewer and links read it as is.
 */
export function assistantWorkspaceEndpoints(requestId: string): WorkspaceFilesEndpoints {
  const base = `/web/assistant/requests/${encodeURIComponent(requestId)}/workspace`;
  return {
    treeUrl: (_workspacePath, path) => `${base}/tree?${new URLSearchParams({ path })}`,
    fileUrl: (_workspacePath, path) => `${base}/view?${new URLSearchParams({ path })}`,
    downloadUrl: (baseUrl, file) => `${baseUrl}${base}/file?${new URLSearchParams({ path: file.path, download: '' })}`,
  };
}

/** The sessions' Files panel, files only (no repository, changes or device for a request's folder). */
function AssistantFilesContent() {
  const { open, workspacePath, setSize } = useWorkspacePanel();
  if (!workspacePath) return null;
  return (
    <div className="flex min-h-0 w-full min-w-0 grow flex-col overflow-hidden" data-testid="assistant-workspace-files">
      <WorkspaceViewerPanel key={workspacePath} workspacePath={workspacePath} onSizeChange={setSize} visible={open} readsChanges={false} filesOnly />
    </div>
  );
}

/**
 * One request's thread with the sessions' Files beside it: the same provider, docked card or
 * popover, tree, viewer (Markdown with annotations, media, download) and file links, reading the
 * request's folder. The folder is read again whenever the thread moves (a turn wrote files).
 */
function AssistantRequestFiles({ requestId, revision, children }: { requestId: string; revision: string; children: ReactNode }) {
  const endpoints = useMemo(() => assistantWorkspaceEndpoints(requestId), [requestId]);
  const workspacePath = assistantWorkspacePath(requestId);
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTreeScope(workspacePath) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFileScope(workspacePath) });
  }, [queryClient, workspacePath, revision]);
  return (
    <WorkspaceFilesEndpointsContext.Provider value={endpoints}>
      <WorkspaceFilesPanelProvider workspace={{ workspacePath, threadId: requestId }} content={<AssistantFilesContent />}>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {children}
          <WorkspaceFilesSurface />
        </div>
      </WorkspaceFilesPanelProvider>
    </WorkspaceFilesEndpointsContext.Provider>
  );
}

function useAssistantMarkdown() {
  const components = useWorkspaceFileLinkComponents();
  const remarkPlugins = useWorkspaceFileLinkPlugins();
  return { ...(components ? { components } : {}), ...(remarkPlugins ? { remarkPlugins } : {}) };
}

/** What the app hands the assistant panel for a request's workspace: the sessions' Files, toggle and file links. */
export const assistantWorkspaceSlot: AssistantWorkspaceSlot = {
  Thread: AssistantRequestFiles,
  Toggle: WorkspaceFilesToggle,
  useMarkdown: useAssistantMarkdown,
};
