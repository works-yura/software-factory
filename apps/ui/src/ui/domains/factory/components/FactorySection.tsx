import { Button } from '@mastra/playground-ui/components/Button';
import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { Brain, ChartColumn, MessagesSquare, Plus, Settings2, SquareKanban } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { NavLink, useLocation, useParams, useResolvedPath } from 'react-router';

import { useKnowledgeAvailable } from '../../../../hooks/useKnowledgeAvailable';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useCanEditBoards } from '../../../../hooks/useIntakeRoutes';
import { boardConfigPath, newBoardPath } from '../../boardConfig/boardConfigPaths';
import { boardPath, orderedBoards } from '../boardCatalog';
import { supervisorChatEnabled } from '../../supervisor/services/supervisor';
import { rememberedBoardPath } from '../services/boardViews';
import { useOverlays } from '../../../lib/overlays';
import { boardTitle } from '../../../i18n/boardLabels';
import { useTranslation } from 'react-i18next';

export function FactorySection() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const knowledge = useKnowledgeAvailable(factoryId);
  const catalog = useBoardCatalog(factoryId);
  const { t } = useTranslation('nav');
  const overlays = useOverlays();
  const { pathname } = useLocation();
  // Only organization admins may add a board; the server refuses everyone else.
  const canAddBoard = useCanEditBoards(factoryId);

  if (!factoryId) return null;
  const boards = catalog.data ? orderedBoards(catalog.data) : [];
  // Settings open on the board in view, or the first board from anywhere else.
  const configured =
    boards.find(board => {
      const path = boardPath(factoryId, board.id);
      return pathname === path || pathname.startsWith(`${path}/`);
    }) ?? boards[0];

  return (
    <nav className="flex flex-col gap-2" aria-label={t('factory')}>
      {supervisorChatEnabled() ? (
        <Sidebar.NavList>
          <FactoryLink to={`/factories/${factoryId}/supervisor`} icon={MessagesSquare} label={t('supervisor')} />
        </Sidebar.NavList>
      ) : null}
      <section className="flex flex-col gap-1" aria-label={t('boards')}>
        <Sidebar.NavHeader
          className="mt-0"
          action={
            <div className="flex items-center gap-0.5">
              {canAddBoard && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('newBoard')}
                  tooltip={t('newBoard')}
                  render={<NavLink to={newBoardPath(factoryId)} onClick={() => overlays.close('sidebar')} />}
                >
                  <Plus aria-hidden />
                </Button>
              )}
              {configured && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('boardSettings')}
                tooltip={t('boardSettings')}
                render={
                  <NavLink to={boardConfigPath(factoryId, configured.id)} onClick={() => overlays.close('sidebar')} />
                }
              >
                <Settings2 aria-hidden />
              </Button>
              )}
            </div>
          }
        >
          {t('boards')}
        </Sidebar.NavHeader>
        <Sidebar.NavList>
          {catalog.isPending ? (
            <li role="status">{t('loadingBoards')}</li>
          ) : catalog.isError ? (
            <li role="alert">{t('boardsError')}</li>
          ) : catalog.data.length === 0 ? (
            <li>{t('noBoards')}</li>
          ) : (
            boards.map(board => (
              <FactoryLink
                key={board.id}
                to={rememberedBoardPath(factoryId, board.id)}
                icon={SquareKanban}
                label={boardTitle(board.id, board.title)}
                action={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('configureNamedBoard', { name: boardTitle(board.id, board.title) })}
                    tooltip={t('configureBoard')}
                    className="group-focus-within/board:flex group-hover/board:flex pointer-fine:hidden"
                    render={
                      <NavLink to={boardConfigPath(factoryId, board.id)} onClick={() => overlays.close('sidebar')} />
                    }
                  >
                    <Settings2 aria-hidden />
                  </Button>
                }
              />
            ))
          )}
        </Sidebar.NavList>
      </section>
      <Sidebar.NavList>
        <FactoryLink to={`/factories/${factoryId}/analytics`} icon={ChartColumn} label={t('analytics')} />
        {knowledge.available ? (
          <FactoryLink to={`/factories/${factoryId}/knowledge`} icon={Brain} label={t('knowledge')} />
        ) : null}
      </Sidebar.NavList>
    </nav>
  );
}

function FactoryLink({
  to,
  icon: Icon,
  label,
  action,
}: {
  to: string;
  icon: ComponentType<{ size?: number }>;
  label: string;
  /** Revealed on hover or focus, beside the link rather than inside it. */
  action?: ReactNode;
}) {
  const overlays = useOverlays();
  const { pathname } = useLocation();
  const { pathname: targetPathname } = useResolvedPath(to);
  const isActive = pathname === targetPathname || pathname.startsWith(`${targetPathname}/`);

  return (
    <Sidebar.NavLink
      link={{ name: label, url: to }}
      isActive={isActive}
      className={action ? 'group/board' : undefined}
      action={action}
      render={
        <NavLink to={to} onClick={() => overlays.close('sidebar')}>
          <Icon />
          <Sidebar.NavLabel>{label}</Sidebar.NavLabel>
        </NavLink>
      }
    />
  );
}
