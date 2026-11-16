import { lazy, Suspense, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceChanges, useWorkspaceFile } from '../../../../hooks/use-fs';
import { useFactoryQuery } from '../../../../hooks/useFactories';
import { useServerFeatures } from '../../../../hooks/useServerFeatures';
import { useUserSessionQuery } from '../../../../hooks/useWorkspaces';
import type { WorkspacePanelSize } from '../layout';
import { WorkItemFeedPanel } from '../../factory/components/feed/WorkItemFeedPanel';
import type { WorkItem } from '../../factory/services/workItems';
import type { RepositoryProviders } from './changes/tree/change-tree';
import { WorkspaceChangesPanel } from './WorkspaceChangesPanel';
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser';
import { WorkspaceFileViewer } from './WorkspaceFileViewer';
import { WorkspaceOverview } from './WorkspaceOverview';
import { WorkspacePanelContext } from '../context/WorkspacePanelContext';
import { selectWorkspaceFilePreview } from './workspace-file-preview';

// three.js and the device models load only when someone opens the device view.
const WorkspaceDevicePanel = lazy(() => import('./WorkspaceDevicePanel'));

interface WorkspaceViewerPanelProps {
  workspacePath: string;
  onSizeChange?: (size: WorkspacePanelSize) => void;
  visible?: boolean;
  /** False keeps the overview from reading changes, which would wake an idle sandbox. */
  readsChanges?: boolean;
  workItem?: WorkItem;
  factoryProjectId?: string;
  /** The Factory session this workspace belongs to; enables session actions such as recreating the sandbox. */
  sessionId?: string;
  /**
   * Only the files (tree and file view), for a workspace that is no session's (an assistant request's
   * folder): no overview, changes, feed or device, and «back» from the tree goes nowhere.
   */
  filesOnly?: boolean;
}

type WorkspacePanelView =
  | { type: 'overview' }
  | { type: 'files'; selectedPath?: string }
  | { type: 'file'; path: string }
  | { type: 'changes' }
  | { type: 'feed' }
  | { type: 'device' };

export function WorkspaceViewerPanel({
  workspacePath,
  onSizeChange,
  visible = true,
  readsChanges = true,
  workItem,
  factoryProjectId,
  sessionId,
  filesOnly = false,
}: WorkspaceViewerPanelProps) {
  const session = useUserSessionQuery(sessionId);
  const canRecreateSandbox = session.data?.capabilities?.recreateSandbox === true;
  const deviceAvailable = useServerFeatures().data?.device === true;
  const { t } = useTranslation('workspaces');
  const [view, setView] = useState<WorkspacePanelView>(filesOnly ? { type: 'files' } : { type: 'overview' });
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);
  // A file asked for from the chat (a document link) replaces whatever the panel shows, once per ask.
  const requestedFile = useContext(WorkspacePanelContext)?.requestedFile;
  const [shownRequest, setShownRequest] = useState<number>();
  if (requestedFile && requestedFile.request !== shownRequest) {
    setShownRequest(requestedFile.request);
    setView({ type: 'file', path: requestedFile.path });
    onSizeChange?.('full');
  }
  const selectedFilePath = view.type === 'file' ? view.path : undefined;
  const changes = useWorkspaceChanges(workspacePath, { enabled: visible && readsChanges && !filesOnly });
  const factory = useFactoryQuery(factoryProjectId);
  const repositoryProviders: RepositoryProviders | undefined = factory.data
    ? Object.fromEntries(factory.data.repositories.map(repo => [repo.slug.toLowerCase(), repo.provider]))
    : undefined;
  const file = useWorkspaceFile(workspacePath, selectedFilePath, {
    enabled: visible && view.type === 'file',
    select: selectWorkspaceFilePreview,
  });

  const showOverview = () => {
    setView({ type: 'overview' });
    onSizeChange?.('compact');
  };
  const showView = (type: 'files' | 'changes') => {
    setView({ type });
    onSizeChange?.('full');
  };
  // The feed grows with the conversation, so an empty one is a composer rather than a void.
  const showFeed = () => {
    setView({ type: 'feed' });
    onSizeChange?.('half');
  };

  // Device preview asks for half the chat: enough for a phone, small beside the conversation.
  const showDevice = () => {
    setView({ type: 'device' });
    onSizeChange?.('half');
  };

  if (view.type === 'device') {
    return (
      <Suspense fallback={<p className="text-muted-foreground p-3 text-sm">{t('device.loading')}</p>}>
        <WorkspaceDevicePanel threadId={sessionId ?? workspacePath} visible={visible} onBack={showOverview} />
      </Suspense>
    );
  }

  if (view.type === 'feed' && workItem) {
    return (
      <WorkItemFeedPanel item={workItem} factoryProjectId={factoryProjectId} visible={visible} onBack={showOverview} />
    );
  }

  if (view.type === 'changes') {
    return (
      <WorkspaceChangesPanel
        workspacePath={workspacePath}
        visible={visible}
        repositoryProviders={repositoryProviders}
        onBack={showOverview}
      />
    );
  }

  if (view.type === 'file') {
    return (
      <WorkspaceFileViewer
        filePath={view.path}
        file={file.data}
        isLoading={file.isLoading || (file.isFetching && !file.data)}
        isRefreshing={file.isFetching}
        error={file.error ?? undefined}
        onRefresh={() => file.refetch()}
        // A chat link may name the file by its absolute sandbox path; the tree knows it by the server's.
        onBack={() => setView({ type: 'files', selectedPath: file.data?.path ?? view.path })}
      />
    );
  }

  if (view.type === 'files') {
    return (
      <WorkspaceFileBrowser
        workspacePath={workspacePath}
        visible={visible}
        selectedFilePath={view.selectedPath}
        onFileSelect={path => setView({ type: 'file', path })}
        openFolders={openFolders}
        showHidden={showHidden}
        onShowHiddenChange={setShowHidden}
        onFolderOpenChange={(path, open) => setOpenFolders(previous => ({ ...previous, [path]: open }))}
        {...(filesOnly ? {} : { onBack: showOverview })}
      />
    );
  }

  return (
    <WorkspaceOverview
      changes={changes.data}
      changesLoading={changes.isLoading}
      changesError={changes.error ?? undefined}
      onShowFiles={() => showView('files')}
      onShowChanges={() => showView('changes')}
      commentCount={workItem?.commentCount}
      onShowComments={workItem ? showFeed : undefined}
      onShowDevice={deviceAvailable ? showDevice : undefined}
      recreateSandbox={
        canRecreateSandbox && sessionId ? { sessionId, factoryId: factoryProjectId, workspacePath } : undefined
      }
    />
  );
}
