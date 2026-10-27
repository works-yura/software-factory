import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { Brain, GitPullRequest, ShieldCheck, SquareKanban } from 'lucide-react';
import type { ComponentType } from 'react';
import { NavLink, useLocation, useParams, useResolvedPath } from 'react-router';

import { useServerFeatures } from '../../../../hooks/useServerFeatures';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { orderedBoards } from '../boardCatalog';
import { rememberedBoardPath } from '../services/boardViews';
import { useOverlays } from '../../../lib/overlays';
import { boardTitle } from '../../../i18n/boardLabels';
import { useTranslation } from 'react-i18next';

export function FactorySection() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const features = useServerFeatures();
  const catalog = useBoardCatalog(factoryId);
  const { t } = useTranslation('nav');

  if (!factoryId) return null;

  return (
    <nav className="flex flex-col gap-2" aria-label={t('factory')}>
      <Sidebar.NavList>
        <FactoryLink to={`/factories/${factoryId}/supervisor`} icon={ShieldCheck} label={t('supervisor')} />
      </Sidebar.NavList>
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
                icon={board.id === 'review' ? GitPullRequest : SquareKanban}
                label={boardTitle(board.id, board.title)}
              />
            ))
          )}
        </Sidebar.NavList>
      </section>
      {features.data?.knowledge ? (
        <Sidebar.NavList>
          <FactoryLink to={`/factories/${factoryId}/knowledge`} icon={Brain} label={t('knowledge')} />
        </Sidebar.NavList>
      ) : null}
    </nav>
  );
}

function FactoryLink({ to, icon: Icon, label }: { to: string; icon: ComponentType<{ size?: number }>; label: string }) {
  const overlays = useOverlays();
  const { pathname } = useLocation();
  const { pathname: targetPathname } = useResolvedPath(to);
  const isActive = pathname === targetPathname || pathname.startsWith(`${targetPathname}/`);

  return (
    <Sidebar.NavLink
      link={{ name: label, url: to }}
      isActive={isActive}
      render={
        <NavLink to={to} onClick={() => overlays.close('sidebar')}>
          <Icon />
          <Sidebar.NavLabel>{label}</Sidebar.NavLabel>
        </NavLink>
      }
    />
  );
}
