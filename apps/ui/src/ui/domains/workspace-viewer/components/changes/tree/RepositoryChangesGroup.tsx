import { Tree } from '@mastra/playground-ui/components/Tree';
import { Txt } from '@mastra/playground-ui/components/Txt';

import type { WorkspaceChangesRepository } from '../../../../../../api/types';
import { ChangeCounts } from '../ChangeCounts';
import { buildChangeTree } from './change-tree';
import type { RepositoryProvider } from './change-tree';
import { ChangeTreeItem } from './ChangeTreeItem';
import type { ChangeTreeFolderState } from './ChangeTreeItem';
import { RepositoryGroupHeader } from './RepositoryGroupHeader';

import { translator } from '../../../../../i18n/t';

const tk = translator('workspaces');

interface RepositoryChangesGroupProps extends ChangeTreeFolderState {
  repository: WorkspaceChangesRepository;
  provider?: RepositoryProvider;
  selectedPath?: string;
  onSelect: (path: string) => void;
}

function repositorySummary(repository: WorkspaceChangesRepository) {
  if (!repository.available) return tk('overview.unavailable');
  return tk('changes.fileCount', { count: repository.changes.length });
}

export function RepositoryChangesGroup({
  repository,
  provider,
  openFolders,
  onFolderOpenChange,
  selectedPath,
  onSelect,
}: RepositoryChangesGroupProps) {
  const tree = buildChangeTree(repository.changes, repository.prefix);
  const open = openFolders[repository.prefix] ?? true;

  return (
    <section aria-label={tk('changes.inRepository', { slug: repository.slug })}>
      <RepositoryGroupHeader
        label={repository.slug}
        provider={provider}
        open={open}
        onOpenChange={next => onFolderOpenChange(repository.prefix, next)}
      >
        <Txt as="span" tone="muted" variant="meta" className="shrink-0">
          {repositorySummary(repository)}
        </Txt>
        {repository.changes.length ? (
          <ChangeCounts additions={repository.additions} deletions={repository.deletions} />
        ) : null}
      </RepositoryGroupHeader>
      {open && tree.length > 0 ? (
        <Tree selectedId={selectedPath} onSelect={onSelect} className="pl-2">
          {tree.map(node => (
            <ChangeTreeItem
              key={node.path}
              node={node}
              openFolders={openFolders}
              onFolderOpenChange={onFolderOpenChange}
            />
          ))}
        </Tree>
      ) : null}
    </section>
  );
}
