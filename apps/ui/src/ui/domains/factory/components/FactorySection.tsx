import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { Brain, MessagesSquare, Plus, SquareKanban } from 'lucide-react';
import type { ComponentType } from 'react';
import { NavLink, useLocation, useParams, useResolvedPath } from 'react-router';
import type { Location } from 'react-router';

import { useKnowledgeAvailable } from '../../../../hooks/useKnowledgeAvailable';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useCanEditBoards } from '../../../../hooks/useIntakeRoutes';
import { boardSettingsPath } from '../../settings/services/boardDraft';
import { orderedBoards } from '../boardCatalog';
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
  // Only organization admins may add a board; the server refuses everyone else.
  const canAddBoard = useCanEditBoards(factoryId);
  const location = useLocation();

  if (!factoryId) return null;

  return (
    <nav className="flex flex-col gap-2" aria-label={t('factory')}>
      {supervisorChatEnabled() ? (
        <Sidebar.NavList>
          <FactoryLink to={`/factories/${factoryId}/supervisor`} icon={MessagesSquare} label={t('supervisor')} />
        </Sidebar.NavList>
      ) : null}
      <section className="flex flex-col gap-1" aria-label={t('boards')}>
        <Sidebar.NavHeader className="mt-0">{t('boards')}</Sidebar.NavHeader>
        <Sidebar.NavList>
          {catalog.isPending ? (
            <li role="status">{t('loadingBoards')}</li>
          ) : catalog.isError ? (
            <li role="alert">{t('boardsError')}</li>
          ) : catalog.data.length === 0 ? (
            <li>{t('noBoards')}</li>
          ) : (
            orderedBoards(catalog.data).map(board => (
              <FactoryLink
                key={board.id}
                to={rememberedBoardPath(factoryId, board.id)}
                icon={SquareKanban}
                label={boardTitle(board.id, board.title)}
              />
            ))
          )}
          {canAddBoard && (
            <FactoryLink
              to={boardSettingsPath(factoryId, { new: true })}
              state={{ from: location }}
              icon={Plus}
              label={t('newBoard')}
            />
          )}
        </Sidebar.NavList>
      </section>
      {knowledge.available ? (
        <Sidebar.NavList>
          <FactoryLink to={`/factories/${factoryId}/knowledge`} icon={Brain} label={t('knowledge')} />
        </Sidebar.NavList>
      ) : null}
    </nav>
  );
}

function FactoryLink({
  to,
  state,
  icon: Icon,
  label,
}: {
  to: string;
  /** Where closing Settings returns to, for a link that opens it. */
  state?: { from: Location };
  icon: ComponentType<{ size?: number }>;
  label: string;
}) {
  const overlays = useOverlays();
  const { pathname } = useLocation();
  const { pathname: targetPathname } = useResolvedPath(to);
  const isActive = pathname === targetPathname || pathname.startsWith(`${targetPathname}/`);

  return (
    <Sidebar.NavLink
      link={{ name: label, url: to }}
      isActive={isActive}
      render={
        <NavLink to={to} state={state} onClick={() => overlays.close('sidebar')}>
          <Icon />
          <Sidebar.NavLabel>{label}</Sidebar.NavLabel>
        </NavLink>
      }
    />
  );
}
