import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { mcpServerState, mcpToolRisk } from '@factory/core';

import { useMcpServerCalls, useMcpServerMutations } from '../../../../../hooks/useMcpServers';
import { relativeTime } from '../../../../../lib/date/relativeTime';
import type { McpErrorKind, McpServer, McpServerStatus, McpToolInfo, McpToolPolicy, McpToolRisk, McpToolTrial } from '../../services/mcpServers';
import { PolicySelect } from './McpServerAccess';

/**
 * Settings › Інтеграції › MCP — how a server is doing and what its tools are, after upstream Mastra
 * Studio's MCP pages (`packages/playground/src/domains/mcps/components`: the tools list, the tool
 * playground, the events list) rebuilt from our design-system parts, with paperclip's risk from MCP
 * annotations and quarantine of new writing tools (`doc/MCP-ACCESS-GOVERNANCE.md`).
 */

/** A failure in the person's language, by its kind; the raw (masked) text stays below it. */
export function mcpErrorText(t: TFunction<'settings'>, kind: McpErrorKind | undefined, error: string | undefined): string {
  const explained = kind && kind !== 'other' ? t(`mcpServers.errors.${kind}`) : undefined;
  if (explained && error) return `${explained} (${error})`;
  return explained ?? error ?? t('mcpServers.errors.other');
}

const STATE_DOT: Record<string, string> = {
  ok: 'bg-green-500',
  error: 'bg-red-500',
  needs_auth: 'bg-amber-500',
  disabled: 'bg-neutral-500',
  unchecked: 'bg-neutral-500',
};

/** The server row's status: a dot and «8 інструментів · перевірено 5 хв тому», or the error. */
export function McpServerHealthLine({ server }: { server: McpServer }) {
  const { t } = useTranslation('settings');
  const state = mcpServerState(server);
  const health = server.health;
  const parts: string[] = [];
  if (state === 'ok' && health) {
    parts.push(t('mcpServers.health.tools', { count: health.tools.length }));
    if (health.checkedAt) parts.push(t('mcpServers.health.checked', { ago: relativeTime(health.checkedAt) }));
    if (health.lastUsedAt) parts.push(t('mcpServers.health.used', { ago: relativeTime(health.lastUsedAt) }));
  } else if ((state === 'error' || state === 'needs_auth') && health) {
    parts.push(mcpErrorText(t, health.errorKind, health.error));
  } else {
    parts.push(t(`mcpServers.health.state.${state}`));
  }
  return (
    <span className="flex items-center gap-2" data-state={state} title={t(`mcpServers.health.state.${state}`)}>
      <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${STATE_DOT[state]}`} />
      <span className="truncate">{parts.join(' · ')}</span>
    </span>
  );
}

type ToolRow = McpToolInfo & { policy: McpToolPolicy; risk: McpToolRisk };

/**
 * The tools to show: the latest check's, else what the server last reported. A tool whose server
 * states no risk but that the catalog lists as writing (`writeTools`) is shown as writing.
 */
export function inspectTools(
  status: McpServerStatus | undefined,
  server: McpServer | undefined,
  policyOf: (tool: string) => McpToolPolicy,
  writeTools: readonly string[] = [],
): ToolRow[] {
  const riskOf = (tool: McpToolInfo & { risk?: McpToolRisk }): McpToolRisk => {
    const risk = tool.risk ?? mcpToolRisk(tool.annotations);
    return risk === 'unknown' && writeTools.includes(tool.name) ? 'write' : risk;
  };
  const tools: Array<McpToolInfo & { risk?: McpToolRisk }> = status?.tools.length ? status.tools : (server?.health?.tools ?? []);
  return tools.map(tool => ({ ...tool, policy: policyOf(tool.name), risk: riskOf(tool) }));
}

/**
 * Each tool: its risk from annotations, description, input schema (collapsed), policy, and
 * «Спробувати» for a read-only tool when an admin looks at a saved server. A tool under review
 * (new and writing since the last check) is highlighted until someone sets its policy.
 */
export function McpToolsPanel({
  tools,
  serverId,
  canEdit,
  onPolicyChange,
}: {
  tools: ToolRow[];
  /** The saved server; «Спробувати» needs one. */
  serverId?: string;
  canEdit: boolean;
  onPolicyChange: (tool: string, policy: McpToolPolicy) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <ul className="flex w-full flex-col gap-2" aria-label={t('mcpServers.tools.title')}>
      {tools.map(tool => (
        <ToolItem key={tool.name} tool={tool} serverId={serverId} canEdit={canEdit} onPolicyChange={onPolicyChange} />
      ))}
    </ul>
  );
}

function ToolItem({
  tool,
  serverId,
  canEdit,
  onPolicyChange,
}: {
  tool: ToolRow;
  serverId?: string;
  canEdit: boolean;
  onPolicyChange: (tool: string, policy: McpToolPolicy) => void;
}) {
  const { t } = useTranslation('settings');
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [trying, setTrying] = useState(false);
  const review = tool.policy === 'review';
  const tryable = tool.risk === 'read' && canEdit && Boolean(serverId);
  const tryHint = !serverId ? t('mcpServers.try.saveFirst') : !canEdit ? t('mcpServers.try.adminOnly') : t('mcpServers.try.readOnlyOnly');

  return (
    <li
      className={`flex flex-col gap-2 rounded-md border p-3 ${review ? 'border-amber-500/60 bg-amber-500/5' : 'border-border1'}`}
      aria-label={tool.name}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Txt as="span" variant="body" tone="ink" className="font-mono">
            {tool.name}
          </Txt>
          <Badge size="xs" variant="neutral">
            {t(`mcpServers.risk.${tool.risk}`)}
          </Badge>
          {review && (
            <Badge size="xs" variant="neutral" className="text-amber-600">
              {t('mcpServers.review.badge')}
            </Badge>
          )}
        </div>
        <PolicySelect label={t('mcpServers.tools.policyFor', { tool: tool.name })} value={tool.policy} onChange={value => onPolicyChange(tool.name, value)} />
      </div>
      {review && (
        <Txt as="p" variant="caption" tone="muted">
          {t('mcpServers.review.hint')}
        </Txt>
      )}
      {tool.description && (
        <Txt as="p" variant="caption" tone="muted">
          {tool.description}
        </Txt>
      )}
      <div className="flex flex-wrap gap-2">
        {tool.inputSchema !== undefined && (
          <Button size="sm" variant="ghost" aria-expanded={schemaOpen} onClick={() => setSchemaOpen(open => !open)}>
            {t('mcpServers.tools.schema')}
          </Button>
        )}
        {tryable ? (
          <Button size="sm" variant="ghost" aria-expanded={trying} onClick={() => setTrying(open => !open)}>
            {t('mcpServers.try.open')}
          </Button>
        ) : (
          tool.risk === 'read' && (
            <Txt as="span" variant="caption" tone="muted">
              {tryHint}
            </Txt>
          )
        )}
      </div>
      {schemaOpen && (
        <pre className="bg-surface2 max-h-60 overflow-auto rounded p-2 text-xs" aria-label={t('mcpServers.tools.schemaOf', { tool: tool.name })}>
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      )}
      {trying && serverId && <TryTool serverId={serverId} tool={tool.name} />}
    </li>
  );
}

function TryTool({ serverId, tool }: { serverId: string; tool: string }) {
  const { t } = useTranslation('settings');
  const { tryTool } = useMcpServerMutations();
  const [text, setText] = useState('{}');
  const [parseError, setParseError] = useState<string>();
  const [trial, setTrial] = useState<McpToolTrial>();
  const [refused, setRefused] = useState<string>();

  const run = () => {
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
      args = parsed as Record<string, unknown>;
    } catch {
      setParseError(t('mcpServers.try.badJson'));
      return;
    }
    setParseError(undefined);
    setRefused(undefined);
    tryTool.mutate(
      { id: serverId, tool, args },
      { onSuccess: setTrial, onError: error => setRefused(error instanceof Error ? error.message : String(error)) },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={t('mcpServers.try.arguments', { tool })}
        className="font-mono text-xs"
        rows={3}
        value={text}
        onChange={event => setText(event.target.value)}
      />
      <Button size="sm" variant="default" className="self-start" disabled={tryTool.isPending} onClick={run}>
        {tryTool.isPending ? t('mcpServers.try.running') : t('mcpServers.try.run')}
      </Button>
      {parseError && (
        <Txt as="p" variant="caption" className="text-destructive-foreground">
          {parseError}
        </Txt>
      )}
      {refused && (
        <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
          {refused}
        </Txt>
      )}
      {trial && (
        <div className="flex flex-col gap-1" role="status" aria-label={t('mcpServers.try.result')}>
          <Txt as="span" variant="caption" tone="muted">
            {trial.ok
              ? t('mcpServers.try.ok', { ms: trial.durationMs })
              : mcpErrorText(t, trial.errorKind, trial.error)}
          </Txt>
          {trial.ok && (
            <pre className="bg-surface2 max-h-72 overflow-auto rounded p-2 text-xs">{JSON.stringify(trial.output, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** The server's last calls (from the audit trail): when, which tool, by whom, how it went, how long. */
export function McpRecentCalls({ serverId }: { serverId: string }) {
  const { t } = useTranslation('settings');
  const calls = useMcpServerCalls(serverId);
  if (calls.isPending) return null;
  const list = calls.data ?? [];
  if (!list.length) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('mcpServers.calls.none')}
      </Txt>
    );
  }
  return (
    <ul className="flex w-full flex-col gap-1" aria-label={t('mcpServers.calls.title')}>
      {list.map(call => (
        <li key={`${call.at}:${call.tool}`} className="flex flex-wrap items-center gap-2">
          <span aria-hidden className={`inline-block size-2 rounded-full ${call.outcome === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
          <Txt as="span" variant="caption" tone="ink" className="font-mono">
            {call.tool}
          </Txt>
          <Txt as="span" variant="caption" tone="muted">
            {[
              relativeTime(call.at),
              call.outcome === 'ok' ? t('mcpServers.calls.ok') : t('mcpServers.calls.error'),
              ...(call.durationMs !== undefined ? [t('mcpServers.calls.duration', { ms: call.durationMs })] : []),
              call.tried ? t('mcpServers.calls.tried') : call.sessionId ? t('mcpServers.calls.session', { id: call.sessionId.slice(0, 8) }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Txt>
          {call.sessionId && call.factoryProjectId && !call.tried && (
            <a className="text-xs underline" href={`/factories/${call.factoryProjectId}/workspaces/${call.sessionId}`}>
              {t('mcpServers.calls.open')}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
