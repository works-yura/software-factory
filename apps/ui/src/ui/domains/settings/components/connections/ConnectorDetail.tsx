import type { ConnectionDetailSection } from '@factory/contracts';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Table } from '@mastra/playground-ui/components/Table';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { useConnectionDetail } from '../../../../../hooks/useConnections';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { SettingsSubsection } from '../SettingsSubsection';
import { ConnectorSettings } from './ConnectorSettings';
import { McpServerSection } from './McpServerSection';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A link the server gave: the provider's page opens in a new tab. */
function MaybeLink({ href, children }: { href?: string; children: string }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline">
      {children}
    </a>
  );
}

/** One block the server laid out: facts as settings rows, settings, a table, or a notice. */
function Section({ connectionId, section }: { connectionId: string; section: ConnectionDetailSection }) {
  if (section.type === 'notice') {
    const variant = section.tone === 'error' ? 'destructive' : section.tone === 'warning' ? 'warning' : 'info';
    return (
      <Notice variant={variant} title={section.title} role={section.tone === 'info' ? 'status' : 'alert'}>
        {section.message && <Notice.Message>{section.message}</Notice.Message>}
        {section.link && (
          <Notice.Message>
            <MaybeLink href={section.link.href}>{section.link.label}</MaybeLink>
          </Notice.Message>
        )}
      </Notice>
    );
  }
  const body =
    section.type === 'settings' ? (
      <ConnectorSettings connectionId={connectionId} section={section} />
    ) : section.type === 'custom' ? (
      <McpServerSection params={section.params} />
    ) : section.type === 'facts' ? (
      <SettingsContainer>
        {section.rows.map(row => (
          <SettingsRow key={row.label} label={row.label} {...(row.detail ? { description: row.detail } : {})}>
            <span className="text-body-sm text-foreground">
              <MaybeLink {...(row.href ? { href: row.href } : {})}>{row.value}</MaybeLink>
            </span>
          </SettingsRow>
        ))}
      </SettingsContainer>
    ) : section.rows.length === 0 ? (
      <Txt as="p" variant="caption" tone="muted">
        {section.empty ?? '—'}
      </Txt>
    ) : (
      <Table variant="inset" {...(section.title ? { 'aria-label': section.title } : {})}>
        <Table.Header>
          <Table.Row>
            {section.columns.map(column => (
              <Table.Head key={column}>{column}</Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {section.rows.map((row, index) => (
            <Table.Row key={`${row.cells[0] ?? ''}:${index}`}>
              {row.cells.map((cell, cellIndex) => (
                <Table.Cell key={cellIndex}>
                  {cellIndex === 0 ? <MaybeLink {...(row.href ? { href: row.href } : {})}>{cell}</MaybeLink> : cell}
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    );
  if (!section.title) return body;
  return (
    <SettingsSubsection title={section.title} {...(section.description ? { description: section.description } : {})}>
      {body}
    </SettingsSubsection>
  );
}

/** A server-described connection's detail sections (`/web/connections/:id/detail`), read live. */
export function ConnectorDetailSections({ id }: { id: string }) {
  const { t } = useTranslation('settings');
  const detail = useConnectionDetail(id);
  if (detail.isPending) return <SkeletonRows label={t('connections.loading')} rows={2} />;
  if (detail.isError) {
    return (
      <Notice variant="destructive" title={t('connections.connector.detailFailed')} role="alert">
        <Notice.Message>{errorMessage(detail.error)}</Notice.Message>
      </Notice>
    );
  }
  return (
    <>
      {detail.data.sections.map((section, index) => (
        <Section key={`${section.type}:${section.title ?? ''}:${index}`} connectionId={id} section={section} />
      ))}
    </>
  );
}
