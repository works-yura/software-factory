import { Button } from '@mastra/playground-ui/components/Button';
import { PageHeader } from '@mastra/playground-ui/components/PageHeader';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';

import { factoryConnections } from '../../connections/connections';
import { settingsSectionPath } from '../../settingsSections';
import { localized } from '../mcp-servers/McpCatalogFields';
import { ConnectionIcon } from './ConnectionIcon';
import { HealthBadge, useRowKind } from './ConnectionList';
import { useConnectionSources } from './useConnectionSources';

/**
 * Settings › Підключення's page header, as Mastra's Connect pages: the list has the title and
 * «+ Додати підключення» (an icon on phones); a connection's page has «← Підключення» above, its
 * logo, its name and its health badge. The title takes focus when the page opens, as every
 * settings section's does, so a screen reader announces where it landed.
 */
export function ConnectionsPageHeader() {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const [params, setParams] = useSearchParams();
  const isMobile = useIsMobile(640);
  const { sources } = useConnectionSources();
  const kindOf = useRowKind();
  const open = params.get('connection');
  const titleId = useId();
  // The sidebar's phone breakpoint: there the mobile header names the page instead.
  const sidebarMobile = useIsMobile();
  useEffect(() => {
    if (!sidebarMobile) document.getElementById(titleId)?.focus();
  }, [titleId, open, sidebarMobile]);
  const title = (text: string) => (
    <PageHeader.Title id={titleId} tabIndex={-1} className="outline-hidden">
      {text}
    </PageHeader.Title>
  );

  if (!factoryId) return <PageHeader>{title(t('connections.title'))}</PageHeader>;

  if (!open) {
    return (
      <PageHeader>
        {title(t('connections.title'))}
        <PageHeader.Action>
          <Button
            variant="primary"
            size={isMobile ? 'icon-md' : 'md'}
            aria-label={t('connections.add')}
            onClick={() =>
              setParams(current => {
                const next = new URLSearchParams(current);
                next.set('add', '1');
                return next;
              })
            }
          >
            <Plus aria-hidden />
            {!isMobile && t('connections.add')}
          </Button>
        </PageHeader.Action>
      </PageHeader>
    );
  }

  const row = factoryConnections(factoryId, sources).find(candidate => candidate.id === open);
  const entryId = open.startsWith('mcp-new:') ? open.slice('mcp-new:'.length) : undefined;
  const entry = entryId ? sources.mcp?.catalog.find(candidate => candidate.id === entryId) : undefined;
  const kind = open.startsWith('mcp') ? 'mcp' : (open as 'google-cloud');
  const icon = row ? kindOf(row).icon : kind;
  const name =
    row?.title ??
    (entry ? localized(entry.label) : entryId ? t('connections.detail.newMcp') : t(`connections.kinds.${kind}`, { defaultValue: t('connections.title') }));

  return (
    <PageHeader>
      <PageHeader.Eyebrow>
        <Link to={settingsSectionPath(factoryId, 'integrations')}>
          <ArrowLeft aria-hidden className="size-3.5" />
          {t('connections.detail.back')}
        </Link>
      </PageHeader.Eyebrow>
      <PageHeader.Icon>
        <ConnectionIcon kind={icon} />
      </PageHeader.Icon>
      {title(name)}
      {row && (
        <PageHeader.Meta beside>
          <HealthBadge row={row} />
        </PageHeader.Meta>
      )}
    </PageHeader>
  );
}
