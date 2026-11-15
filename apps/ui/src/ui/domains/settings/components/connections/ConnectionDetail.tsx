import type { ConnectionView, ConnectorView } from '@factory/contracts';
import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFactoryAuth } from '../../../../../hooks/useFactoryAuth';
import { useFactoryMembers } from '../../../../../hooks/useFactoryMembers';
import { ConnectorDetailSections } from './ConnectorDetail';
import { HealthBadge, useRenameConnection } from './ConnectionList';
import { McpServerSection } from './McpServerSection';
import { TimeAgo } from './TimeAgo';
import { GithubPatBlock } from '../GithubPatBlock';

/** «Хто»: a member's name, «вами», or nothing when unknown. */
function useWho(factoryId: string) {
  const { t } = useTranslation('settings');
  const me = useFactoryAuth().data?.user?.userId;
  const members = useFactoryMembers(factoryId).data ?? [];
  return (userId: string | undefined) => {
    if (!userId) return undefined;
    if (userId === me) return t('connections.detail.byYou');
    return members.find(member => member.id === userId)?.name;
  };
}

/** «Назва» with «Зберегти» when the server allows renaming; otherwise just the name. */
function NameRow({ view }: { view: ConnectionView }) {
  const { t } = useTranslation('settings');
  const { rename, pending } = useRenameConnection();
  const [name, setName] = useState(view.label);
  const next = name.trim();
  return (
    <SettingsRow label={t('connections.detail.name')}>
      {view.actions.rename === true ? (
        <form
          className="flex w-full items-center justify-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (next && next !== view.label) rename(view, next);
          }}
        >
          <Input aria-label={t('connections.detail.name')} value={name} onChange={event => setName(event.target.value)} className="min-w-0 flex-1 sm:w-56 sm:flex-none" />
          <Button type="submit" size="sm" variant="primary" disabled={!next || next === view.label || pending}>
            {t('connections.detail.save')}
          </Button>
        </form>
      ) : (
        <span className="text-body-sm text-foreground max-w-full truncate" title={view.label}>
          {view.label}
        </span>
      )}
    </SettingsRow>
  );
}

/** «Огляд», as Mastra's: name, account, how it connects, who depends on it, created, state, the connection's id. */
function Overview({ view, factoryId, organizationWide }: { view: ConnectionView; factoryId: string; organizationWide: string }) {
  const { t } = useTranslation('settings');
  const who = useWho(factoryId);
  const by = who(view.createdBy);
  const account = view.accountLabel ?? (view.scope === 'organization' ? organizationWide : '—');
  return (
    <SettingsContainer>
      <NameRow view={view} />
      <SettingsRow label={t('connections.detail.account')}>
        {/* Aligned like every other value (left when the row stacks, right beside the label); a long
            account name is cut and shown whole on hover. */}
        <span className="text-body-sm flex max-w-full min-w-0 flex-col items-start text-left sm:items-end sm:text-right">
          <span className="text-foreground max-w-full truncate" title={account}>
            {account}
          </span>
          {view.accountDetail && (
            <span className="text-meta text-muted-foreground max-w-full truncate" title={view.accountDetail}>
              {view.accountDetail}
            </span>
          )}
        </span>
      </SettingsRow>
      {view.method && (
        <SettingsRow label={t('connections.connector.method')}>
          <span className="text-body-sm text-foreground">{view.method}</span>
        </SettingsRow>
      )}
      {view.dependents && (
        <SettingsRow label={t('connections.connector.dependents')}>
          <span className="text-body-sm text-foreground">{view.dependents}</span>
        </SettingsRow>
      )}
      <SettingsRow label={t('connections.detail.created')}>
        <span className="text-body-sm text-foreground flex items-center gap-1.5">
          {view.createdAt ? <TimeAgo value={view.createdAt} /> : <span className="text-muted-foreground">{t('connections.detail.notRecorded')}</span>}
          {view.createdAt && by && <span className="text-muted-foreground">· {by}</span>}
        </span>
      </SettingsRow>
      <SettingsRow label={t('connections.detail.state')} {...(view.state.message ? { description: view.state.message } : {})}>
        <span className="flex items-center gap-2">
          <HealthBadge view={view} />
          {view.state.tone !== 'ok' && <span className="text-body-sm text-muted-foreground">{view.state.label}</span>}
        </span>
      </SettingsRow>
      <SettingsRow label={t('connections.detail.id')}>
        <span className="bg-surface-panel shadow-inset flex min-w-0 items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2">
          <span className="text-meta text-muted-foreground truncate font-mono">{view.id}</span>
          <CopyButton content={view.id} size="icon-sm" variant="ghost" tooltip={t('connections.detail.copyId')} />
        </span>
      </SettingsRow>
    </SettingsContainer>
  );
}

/** A `new:<connector>:<method>` link: the connector and its editor method, when the server offers one. */
export function editorMethodOf(id: string, connectors: readonly ConnectorView[]) {
  const match = /^new:([^:]+):(.+)$/.exec(id);
  if (!match) return undefined;
  const connector = connectors.find(candidate => candidate.id === match[1]);
  const method = connector?.methods.find(candidate => candidate.id === match[2]);
  return connector && method?.editor ? { connector, method, editor: method.editor } : undefined;
}

/**
 * One connection's page (`?connection=`): «Огляд» from the connection's view, then the sections the
 * server lays out for it. A `new:<connector>:<method>` page is that method's editor (the one custom
 * editor, ADR-0035).
 */
export function ConnectionDetail({
  id,
  factoryId,
  views,
  connectors,
  organizationWide,
  onDone,
}: {
  id: string;
  factoryId: string;
  views: readonly ConnectionView[];
  connectors: readonly ConnectorView[];
  organizationWide: string;
  /** Back to the list, after a new connection was saved in its editor. */
  onDone: () => void;
}) {
  const { t } = useTranslation('settings');
  const editor = editorMethodOf(id, connectors);
  if (editor) {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <McpServerSection params={editor.editor.params} onSaved={onDone} />
      </div>
    );
  }
  const view = views.find(candidate => candidate.id === id);
  if (!view) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('connections.detail.notFound')}
      </Txt>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Overview view={view} factoryId={factoryId} organizationWide={organizationWide} />
      <ConnectorDetailSections id={view.id} />
      {/* The optional org-wide gh CLI tokens sandboxes use in place of this connection's token. */}
      {view.connector.id === 'github' && <GithubPatBlock />}
    </div>
  );
}
