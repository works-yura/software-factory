import { Breadcrumb, Crumb } from '@mastra/playground-ui/components/Breadcrumb';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { useSidebar } from '@mastra/playground-ui/components/Sidebar';
import { SettingsContainer, SettingsSkeleton } from '@mastra/playground-ui/new/settings';
import { cn } from '@mastra/playground-ui/utils/cn';
import { Link } from 'react-router';

import { BoardRequestError, useBoardQuery } from '../../hooks/useBoardEditor';
import { useFactorySkillsQuery } from '../../hooks/useFactorySkills';
import { useSidebarHeaderSlots } from '../domains/chat/components/useSidebarHeaderSlots';
import { useShownDraft } from '../domains/boardConfig/BoardDraftProvider';
import { boardConfigPath } from '../domains/boardConfig/boardConfigPaths';
import { BoardConfigEditor } from '../domains/boardConfig/components/BoardConfigEditor';
import { BoardConfigHeader } from '../domains/boardConfig/components/BoardConfigHeader';
import { useBoardConfigRoute } from '../domains/boardConfig/hooks/useBoardConfigRoute';
import { boardPath } from '../domains/factory/boardCatalog';
import { useActiveFactory } from '../domains/workspaces/components/FactoryLayout';
import { LoadErrorState } from '../ui/LoadErrorState';
import { translator } from '../i18n/t';

const tk = translator('boardConfig');

/** Settings read best in a short line, so the page keeps to a centered column narrower than the layout's. */
const COLUMN = 'mx-auto w-full max-w-2xl';

/** Factory › board › Configure: the board's General page, or one phase's page. The sidebar lists the pages. */
export function BoardConfigPage() {
  const factory = useActiveFactory();
  const route = useBoardConfigRoute();
  const boardId = route?.boardId ?? '';
  const phaseKey = route?.phaseKey;
  const { isMobile, desktopState } = useSidebar();
  const sidebarHidden = isMobile || desktopState === 'collapsed';
  const query = useBoardQuery(factory.id, boardId);
  const skills = useFactorySkillsQuery(factory.id);

  const board = query.data?.board;
  // Phases added but not yet saved have pages too.
  const shownDraft = useShownDraft(factory.id, boardId, board);
  const shownPhase = phaseKey ? shownDraft?.phases.find(phase => phase.key === phaseKey) : undefined;
  const generalPath = boardConfigPath(factory.id, boardId);

  const slots = useSidebarHeaderSlots({
    breadcrumbs:
      sidebarHidden && board ? (
        <Breadcrumb label={tk('page.breadcrumb')} className="min-w-0 flex-1 overflow-hidden">
          <Crumb as={Link} to={boardPath(factory.id, boardId)}>
            {shownDraft?.name || board.name}
          </Crumb>
          {phaseKey ? (
            <Crumb as={Link} to={generalPath}>
              {tk('page.configure')}
            </Crumb>
          ) : (
            <Crumb as="span" isCurrent>
              {tk('page.configure')}
            </Crumb>
          )}
          {shownPhase && (
            <Crumb as="span" isCurrent>
              {shownPhase.name}
            </Crumb>
          )}
        </Breadcrumb>
      ) : undefined,
  });

  const header =
    query.isSuccess && (!phaseKey || shownPhase) ? (
      <div className={cn(COLUMN, 'pb-8')}>
        <BoardConfigHeader
          key={`${boardId}:${query.data.board.revision ?? 'code'}`}
          factoryId={factory.id}
          boardId={boardId}
          phaseKey={phaseKey}
          response={query.data}
        />
      </div>
    ) : undefined;

  return (
    <PageLayout variant="narrow" header={header} {...slots}>
      <div className={COLUMN}>
        {query.isPending ? (
          <SettingsContainer>
            <SettingsSkeleton label={tk('page.loadingBoard')} rows={3} />
          </SettingsContainer>
        ) : query.isError && query.error instanceof BoardRequestError && query.error.code === 'board_not_found' ? (
          <EmptyState
            variant="fill"
            titleSlot={<span role="alert">{tk('page.notInstalled')}</span>}
          />
        ) : query.isError ? (
          <LoadErrorState
            title={tk('page.loadError')}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <BoardConfigEditor
            key={`${boardId}:${query.data.board.revision ?? 'code'}`}
            factory={factory}
            boardId={boardId}
            phaseKey={phaseKey}
            response={query.data}
            skills={skills.data?.skills}
            skillsEditable={skills.data?.canEdit ?? false}
            sidebarHidden={sidebarHidden}
            onReload={() => void query.refetch()}
          />
        )}
      </div>
    </PageLayout>
  );
}
