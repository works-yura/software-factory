import { mcpCatalogVariant, uniqueMcpServerSlug } from '@factory/core';
import type { McpCatalogEntry } from '@factory/core';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useFactoriesQuery } from '../../../../../hooks/useFactories';
import { useMcpServerMutations, useMcpSuggestions } from '../../../../../hooks/useMcpServers';
import type {
  McpServer,
  McpServerAssignment,
  McpServerInput,
  McpServersState,
  McpServerStatus,
  McpToolPolicies,
  McpToolPolicy,
} from '../../services/mcpServers';

/** JSON with object keys sorted, to compare two configs regardless of key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
import { McpCatalogFields, localized } from './McpCatalogFields';
import type { CatalogFieldValues } from './McpCatalogFields';
import { AssignmentRow, newAssignment, PolicySelect } from './McpServerAccess';
import { inspectTools, mcpErrorText, McpRecentCalls, McpToolsPanel } from './McpServerInspect';
import { integrationsPath } from '../../settingsSections';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `KEY=value` lines to a map; a line without `=` is skipped. */
function parseLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return result;
}

const toLines = (map: Record<string, string>) =>
  Object.entries(map)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');

/** What the editor starts from: a catalog entry, or the person's own server. */
export type McpServerStart = { kind: 'catalog'; entry: McpCatalogEntry } | { kind: 'custom' };

type CustomMode = 'local' | 'address';

interface Props {
  server?: McpServer;
  start: McpServerStart;
  state: McpServersState;
  onSaved: () => void;
}

/**
 * The form for a server: its name, then the inputs its catalog entry declares (or a local command /
 * an address for an own server), then access, tool policy and masking. The identifier is made from
 * the name and kept under «Додатково».
 */
export function McpServerEditor({ server, start, state, onSaved }: Props) {
  const { t } = useTranslation('settings');
  const { factoryId } = useParams<{ factoryId: string }>();
  const canEdit = state.canEdit;
  // An integration's server (Google Cloud's «База»): its binding sets the config and access; here a
  // person changes only what each tool may do and the masking.
  const managedBy = server?.owner?.integration;
  const configLocked = !canEdit || managedBy !== undefined;
  const factories = (useFactoriesQuery().data ?? []).map(factory => ({ id: factory.id, name: factory.name }));
  const { save, remove, check, checkDraft, reconnect } = useMcpServerMutations();
  const entry = start.kind === 'catalog' ? start.entry : undefined;
  const launch = server?.launch;

  const [label, setLabel] = useState(server?.label ?? (entry ? localized(entry.label) : ''));
  const [name, setName] = useState(server?.name ?? '');
  const [editingName, setEditingName] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  // A new server opened from a Factory's settings starts with that Factory's access (removable).
  const [assignments, setAssignments] = useState<McpServerAssignment[]>(
    server?.assignments ?? (factoryId ? [{ factoryProjectId: factoryId, sessions: ['chat', 'personal', 'cards'] }] : []),
  );
  const [toolPolicies, setToolPolicies] = useState<McpToolPolicies>(server?.toolPolicies ?? { default: 'allow', tools: {} });
  const [maskPersonalData, setMask] = useState(server?.maskPersonalData ?? true);
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [callTimeoutSeconds, setCallTimeoutSeconds] = useState(server?.callTimeoutMs ? String(Math.round(server.callTimeoutMs / 1000)) : '');
  const [status, setStatus] = useState<McpServerStatus>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [variantId, setVariantId] = useState(
    launch?.transport === 'catalog' ? launch.variant : entry?.variants.length === 1 ? entry.variants[0]!.id : undefined,
  );
  const [fieldValues, setFieldValues] = useState<CatalogFieldValues>({
    inputs: launch?.transport === 'catalog' ? launch.inputs : {},
    credentials: launch?.transport === 'catalog' ? launch.credentials : {},
    secrets: {},
  });
  const variant = entry ? mcpCatalogVariant(entry, variantId) : undefined;

  const [mode, setMode] = useState<CustomMode>(launch?.transport === 'http' ? 'address' : 'local');
  const [command, setCommand] = useState(launch?.transport === 'stdio' ? (launch.command ?? '') : '');
  const [args, setArgs] = useState(launch?.transport === 'stdio' ? launch.args.join('\n') : '');
  const [url, setUrl] = useState(launch?.transport === 'http' ? launch.url : '');
  const [plainLines, setPlainLines] = useState(
    launch?.transport === 'stdio' ? toLines(launch.env) : launch?.transport === 'http' ? toLines(launch.headers) : '',
  );
  const [secretLines, setSecretLines] = useState('');

  const firstFactory = assignments[0]?.factoryProjectId || undefined;
  const suggestions = useMcpSuggestions(entry ? firstFactory : undefined).data ?? {};
  const storedSecrets = server?.secretNames ?? { env: [], headers: [], files: [] };
  const takenNames = state.servers.filter(other => other.id !== server?.id).map(other => other.name);
  const identifier = name || uniqueMcpServerSlug(label || 'server', takenNames);

  const buildInput = (): McpServerInput => {
    const timeout = Number(callTimeoutSeconds);
    const common = {
      name: identifier,
      label,
      assignments,
      toolPolicies,
      maskPersonalData,
      enabled,
      ...(callTimeoutSeconds.trim() && Number.isFinite(timeout) && timeout > 0 ? { callTimeoutMs: Math.round(timeout * 1000) } : {}),
    };
    if (entry && variant) {
      const keys = new Set(variant.fields.map(field => field.key));
      const inputs = Object.fromEntries(
        Object.entries(fieldValues.inputs).filter(([key, value]) => keys.has(key) && value !== ''),
      );
      const credentials = Object.fromEntries(Object.entries(fieldValues.credentials).filter(([key]) => keys.has(key)));
      const env: Record<string, string | null> = {};
      const files: Record<string, string | null> = {};
      for (const field of variant.fields) {
        const typed = fieldValues.secrets[field.key];
        if (field.credential && credentials[field.key] && storedSecrets.files.includes(field.key)) files[field.key] = null;
        if (!field.secret || field.credential || !typed?.trim()) continue;
        if (field.file) files[field.key] = typed;
        else env[field.key] = typed;
      }
      const secrets = {
        ...(Object.keys(env).length ? { env } : {}),
        ...(Object.keys(files).length ? { files } : {}),
      };
      return {
        ...common,
        launch: { transport: 'catalog', entry: entry.id, variant: variant.id, inputs, credentials },
        ...(Object.keys(secrets).length ? { secrets } : {}),
      };
    }
    const secretMap = parseLines(secretLines);
    const hasSecrets = Object.keys(secretMap).length > 0;
    if (mode === 'address') {
      return {
        ...common,
        launch: { transport: 'http', url, headers: parseLines(plainLines) },
        ...(hasSecrets ? { secrets: { headers: secretMap } } : {}),
      };
    }
    return {
      ...common,
      launch: { transport: 'stdio', command, args: args.split('\n').map(arg => arg.trim()).filter(Boolean), env: parseLines(plainLines) },
      ...(hasSecrets ? { secrets: { env: secretMap } } : {}),
    };
  };

  const submit = () =>
    save.mutate(
      { ...buildInput(), ...(server ? { id: server.id } : {}) },
      {
        onSuccess: () => {
          toast.success(t('mcpServers.saved'));
          setFieldValues(current => ({ ...current, secrets: {} }));
          setSecretLines('');
          onSaved();
        },
        onError: error => toast.error(errorMessage(error)),
      },
    );

  // Required inputs still empty: «Перевірити» names them instead of starting a server that cannot run.
  const missing = variant
    ? variant.fields
        .filter(field => field.required)
        .filter(field =>
          field.credential
            ? !fieldValues.credentials[field.key] && !storedSecrets.files.includes(field.key)
            : field.secret
              ? !fieldValues.secrets[field.key]?.trim() && ![...storedSecrets.env, ...storedSecrets.files].includes(field.key)
              : !fieldValues.inputs[field.key]?.trim() && field.default === undefined,
        )
        .map(field => localized(field.label))
    : [];

  // An editor checks the form as it is, saved or not; someone who may only read checks the saved server.
  // An editor checks the form as it is; a saved server whose launch and secrets are unchanged is
  // checked as stored, which also keeps what was found with it (status, quarantine of new writing tools).
  const draft = buildInput();
  const dirty =
    !server ||
    stableJson(draft.launch) !== stableJson(server.launch) ||
    Object.values(draft.secrets ?? {}).some(values => values && Object.keys(values).length > 0);
  const runCheck = () => {
    const done = { onSuccess: setStatus, onError: (error: unknown) => toast.error(errorMessage(error)) };
    if (server && (!canEdit || !dirty)) check.mutate(server.id, done);
    else if (canEdit) checkDraft.mutate({ ...(server ? { id: server.id } : {}), server: buildInput() }, done);
  };
  const runReconnect = () => {
    if (!server) return;
    reconnect.mutate(server.id, { onSuccess: setStatus, onError: (error: unknown) => toast.error(errorMessage(error)) });
  };
  const checking = check.isPending || checkDraft.isPending || reconnect.isPending;

  const policyOf = (tool: string) => toolPolicies.tools[tool] ?? toolPolicies.default;
  const setToolPolicy = (tool: string, value: McpToolPolicy) =>
    setToolPolicies(current => {
      const tools = { ...current.tools };
      if (value === current.default) delete tools[tool];
      else tools[tool] = value;
      return { ...current, tools };
    });
  const writeTools = variant?.writeTools ?? [];
  const inspected = inspectTools(status, server, policyOf, writeTools);
  const listedTools = new Set(inspected.map(tool => tool.name));
  const toolNames = Object.keys(toolPolicies.tools).filter(tool => !listedTools.has(tool)).sort();
  const secretKind = mode === 'address' ? 'headers' : 'env';
  const ready = Boolean(label.trim()) && (entry ? Boolean(variant) : mode === 'address' ? Boolean(url.trim()) : Boolean(command.trim()));

  return (
    <SettingsContainer>
      {managedBy && (
        <SettingsRow label={t('mcpServers.managed.title', { integration: t(`mcpServers.managed.by.${managedBy}`, { defaultValue: managedBy }) })} description={t('mcpServers.managed.hint')}>
          {factoryId && (
            <Link to={integrationsPath(factoryId, { tab: 'services', service: 'google-cloud' })} className="underline">
              {t('mcpServers.managed.open')}
            </Link>
          )}
        </SettingsRow>
      )}
      <SettingsRow label={t('mcpServers.label')} description={t('mcpServers.labelHint')}>
        <Input aria-label={t('mcpServers.label')} value={label} disabled={configLocked} onChange={event => setLabel(event.target.value)} />
      </SettingsRow>

      {entry && entry.variants.length > 1 && (
        <SettingsRow label={t('mcpServers.variant')} description={variant?.summary ? localized(variant.summary) : localized(entry.summary)}>
          <Select value={variantId ?? ''} disabled={configLocked} onValueChange={setVariantId}>
            <SelectTrigger aria-label={t('mcpServers.variant')} className="w-56">
              {variant ? localized(variant.label) : t('mcpServers.field.pickChoice')}
            </SelectTrigger>
            <SelectContent>
              {entry.variants.map(candidate => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {localized(candidate.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      )}
      {variant && (
        <McpCatalogFields
          variant={variant}
          values={fieldValues}
          onChange={setFieldValues}
          storedSecrets={[...storedSecrets.env, ...storedSecrets.files]}
          accounts={state.credentials}
          suggestions={suggestions}
          disabled={configLocked}
        />
      )}

      {!entry && (
        <>
          <SettingsRow label={t('mcpServers.custom.how')} description={t(mode === 'address' ? 'mcpServers.custom.addressHint' : 'mcpServers.custom.localHint')}>
            <div className="flex gap-1" role="group" aria-label={t('mcpServers.custom.how')}>
              {(['local', 'address'] as const).map(option => (
                <Button
                  key={option}
                  size="sm"
                  variant={mode === option ? 'default' : 'ghost'}
                  aria-pressed={mode === option}
                  disabled={!canEdit}
                  onClick={() => setMode(option)}
                >
                  {t(`mcpServers.custom.${option}`)}
                </Button>
              ))}
            </div>
          </SettingsRow>
          {mode === 'local' ? (
            <>
              <SettingsRow label={t('mcpServers.custom.command')} description={t('mcpServers.custom.commandHint')}>
                <Input aria-label={t('mcpServers.custom.command')} value={command} disabled={!canEdit} onChange={event => setCommand(event.target.value)} />
              </SettingsRow>
              <SettingsRow label={t('mcpServers.custom.args')} description={t('mcpServers.custom.argsHint')}>
                <Textarea aria-label={t('mcpServers.custom.args')} rows={2} value={args} disabled={!canEdit} onChange={event => setArgs(event.target.value)} />
              </SettingsRow>
            </>
          ) : (
            <SettingsRow label={t('mcpServers.custom.url')} description={t('mcpServers.custom.urlHint')}>
              <Input aria-label={t('mcpServers.custom.url')} value={url} disabled={!canEdit} onChange={event => setUrl(event.target.value)} />
            </SettingsRow>
          )}
          <SettingsRow label={t(`mcpServers.custom.${secretKind}`)} description={t('mcpServers.custom.plainHint')}>
            <Textarea aria-label={t(`mcpServers.custom.${secretKind}`)} rows={2} value={plainLines} disabled={!canEdit} onChange={event => setPlainLines(event.target.value)} />
          </SettingsRow>
          <SettingsRow
            label={t(secretKind === 'env' ? 'mcpServers.custom.secretEnv' : 'mcpServers.custom.secretHeaders')}
            description={
              storedSecrets[secretKind].length
                ? t('mcpServers.custom.secretNames', { names: storedSecrets[secretKind].join(', ') })
                : t('mcpServers.custom.secretHint')
            }
          >
            <Textarea
              aria-label={t(secretKind === 'env' ? 'mcpServers.custom.secretEnv' : 'mcpServers.custom.secretHeaders')}
              rows={2}
              value={secretLines}
              disabled={!canEdit}
              onChange={event => setSecretLines(event.target.value)}
            />
          </SettingsRow>
        </>
      )}

      <SettingsRow label={t('mcpServers.access.title')} description={managedBy ? t('mcpServers.managed.accessHint') : t('mcpServers.access.hint')}>
        <div className="flex w-full flex-col gap-2">
          {managedBy &&
            assignments.map(assignment => (
              <Txt key={assignment.factoryProjectId} as="span" variant="body" tone="ink">
                {factories.find(factory => factory.id === assignment.factoryProjectId)?.name ?? assignment.factoryProjectId}
              </Txt>
            ))}
          {!managedBy && assignments.length === 0 && (
            <Txt as="p" variant="caption" tone="muted">
              {t('mcpServers.access.none')}
            </Txt>
          )}
          {!managedBy && assignments.map((assignment, index) => (
            <AssignmentRow
              key={`${assignment.factoryProjectId}:${index}`}
              assignment={assignment}
              factories={factories}
              usedFactoryIds={assignments.filter((_, at) => at !== index).map(item => item.factoryProjectId)}
              onChange={next => setAssignments(current => current.map((item, at) => (at === index ? next : item)))}
              onRemove={() => setAssignments(current => current.filter((_, at) => at !== index))}
            />
          ))}
          {!configLocked && newAssignment(factories, assignments.map(item => item.factoryProjectId)) && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() =>
                setAssignments(current => {
                  const next = newAssignment(factories, current.map(item => item.factoryProjectId));
                  return next ? [...current, next] : current;
                })
              }
            >
              {t('mcpServers.access.add')}
            </Button>
          )}
        </div>
      </SettingsRow>

      <SettingsRow label={t('mcpServers.tools.default')} description={t('mcpServers.tools.defaultHint')}>
        <PolicySelect label={t('mcpServers.tools.default')} value={toolPolicies.default} onChange={value => setToolPolicies(current => ({ ...current, default: value }))} />
      </SettingsRow>
      <SettingsRow label={t('mcpServers.tools.title')} description={t('mcpServers.tools.checkFirst')}>
        <div className="flex w-full flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {(canEdit || server) && (
              <Button size="sm" variant="ghost" disabled={checking || !ready || missing.length > 0} onClick={runCheck}>
                {checking ? t('mcpServers.checking') : t('mcpServers.check')}
              </Button>
            )}
            {server && canEdit && (
              <Button size="sm" variant="ghost" disabled={checking} onClick={runReconnect}>
                {t('mcpServers.reconnect')}
              </Button>
            )}
          </div>
          {canEdit && missing.length > 0 && (
            <Txt as="p" variant="caption" tone="muted">
              {t('mcpServers.tools.missing', { fields: missing.join(', ') })}
            </Txt>
          )}
          {status && (
            <Txt as="p" variant="caption" tone="muted" className={status.connected ? undefined : 'text-destructive-foreground'} role="status">
              {status.connected
                ? t('mcpServers.status.connected', { count: status.toolCount })
                : t('mcpServers.status.failed', { error: mcpErrorText(t, status.errorKind, status.error) })}
            </Txt>
          )}
          {status?.quarantined?.length ? (
            <Txt as="p" variant="caption" className="text-amber-600" role="alert">
              {t('mcpServers.review.found', { tools: status.quarantined.join(', ') })}
            </Txt>
          ) : null}
          {inspected.length > 0 && (
            <McpToolsPanel tools={inspected} {...(server ? { serverId: server.id } : {})} canEdit={canEdit} onPolicyChange={setToolPolicy} />
          )}
          {toolNames.map(tool => (
            <div key={tool} className="flex flex-wrap items-center justify-between gap-2">
              <Txt as="span" variant="body" tone="ink" className="font-mono">
                {tool}
                {writeTools.includes(tool) && (
                  <Badge size="xs" variant="neutral" className="ml-2">
                    {t('mcpServers.tools.writes')}
                  </Badge>
                )}
              </Txt>
              <PolicySelect label={t('mcpServers.tools.policyFor', { tool })} value={policyOf(tool)} onChange={value => setToolPolicy(tool, value)} />
            </div>
          ))}
        </div>
      </SettingsRow>

      {server && (
        <SettingsRow label={t('mcpServers.calls.title')} description={t('mcpServers.calls.hint')}>
          <McpRecentCalls serverId={server.id} />
        </SettingsRow>
      )}

      <SettingsRow label={t('mcpServers.mask')} description={t('mcpServers.maskHint')}>
        <Switch aria-label={t('mcpServers.mask')} checked={maskPersonalData} disabled={!canEdit} onCheckedChange={setMask} />
      </SettingsRow>
      <SettingsRow label={t('mcpServers.enabled')} description={t('mcpServers.enabledHint')}>
        <Switch aria-label={t('mcpServers.enabled')} checked={enabled} disabled={configLocked} onCheckedChange={setEnabled} />
      </SettingsRow>

      <div className="flex flex-col gap-2">
        <Button size="sm" variant="ghost" className="self-start" aria-expanded={advanced} onClick={() => setAdvanced(open => !open)}>
          {t('mcpServers.advanced')}
        </Button>
        {advanced && (
          <SettingsRow label={t('mcpServers.timeout')} description={t('mcpServers.timeoutHint')}>
            <Input
              aria-label={t('mcpServers.timeout')}
              inputMode="numeric"
              placeholder="60"
              className="w-28"
              value={callTimeoutSeconds}
              disabled={!canEdit}
              onChange={event => setCallTimeoutSeconds(event.target.value.replace(/[^0-9]/g, ''))}
            />
          </SettingsRow>
        )}
        {advanced && (
          <SettingsRow label={t('mcpServers.name')} description={t('mcpServers.nameHint')}>
            {editingName ? (
              <Input aria-label={t('mcpServers.name')} value={name || identifier} disabled={configLocked} onChange={event => setName(event.target.value)} />
            ) : (
              <div className="flex items-center gap-2">
                <Txt as="span" variant="body" tone="ink" className="font-mono" aria-label={t('mcpServers.name')}>
                  {identifier}
                </Txt>
                {!configLocked && (
                  <Button size="sm" variant="ghost" onClick={() => setEditingName(true)}>
                    {t('mcpServers.editName')}
                  </Button>
                )}
              </div>
            )}
          </SettingsRow>
        )}
      </div>

      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" disabled={save.isPending || !ready} onClick={submit}>
            {t('mcpServers.save')}
          </Button>
          {server && !managedBy && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              {t('mcpServers.delete')}
            </Button>
          )}
        </div>
      )}
      {confirmDelete && server && (
        <Dialog open onOpenChange={open => !open && setConfirmDelete(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('mcpServers.deleteTitle', { label: server.label })}</DialogTitle>
              <DialogDescription>{t('mcpServers.deleteBody')}</DialogDescription>
            </DialogHeader>
            <DialogBody />
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t('mcpServers.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  remove.mutate(server.id, {
                    onSuccess: () => {
                      setConfirmDelete(false);
                      toast.success(t('mcpServers.deleted'));
                    },
                    onError: error => toast.error(errorMessage(error)),
                  })
                }
              >
                {t('mcpServers.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SettingsContainer>
  );
}
