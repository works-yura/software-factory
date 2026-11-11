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

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import { useMcpServerMutations, useMcpServersQuery } from '../../../../hooks/useMcpServers';
import { serverToInput } from '../services/mcpServers';
import type {
  McpServer,
  McpServerAssignment,
  McpServerInput,
  McpServerPreset,
  McpServerStatus,
  McpToolPolicy,
} from '../services/mcpServers';
import { SettingsSubsection } from './SettingsSubsection';
import { SourceItemCard } from './SourceItemCard';

const POLICIES: McpToolPolicy[] = ['allow', 'ask', 'deny'];
const CUSTOM_STDIO = 'custom-stdio';
const HTTP = 'http';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `KEY=value` lines to a map; a blank value keeps nothing. */
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

function kindOf(input: McpServerInput): string {
  if (input.launch.transport === 'http') return HTTP;
  return input.launch.preset ?? CUSTOM_STDIO;
}

const EMPTY: McpServerInput = {
  name: '',
  label: '',
  launch: { transport: 'stdio', preset: 'toolbox-firestore', args: [], env: {} },
  assignments: [],
  toolPolicies: { default: 'allow', tools: {} },
  maskPersonalData: true,
  enabled: true,
};

function PolicySelect({ value, onChange, label }: { value: McpToolPolicy; onChange: (value: McpToolPolicy) => void; label: string }) {
  const { t } = useTranslation('settings');
  return (
    <Select value={value} onValueChange={next => onChange(next as McpToolPolicy)}>
      <SelectTrigger aria-label={label} className="w-44">
        {t(`mcpServers.policy.${value}`)}
      </SelectTrigger>
      <SelectContent>
        {POLICIES.map(policy => (
          <SelectItem key={policy} value={policy}>
            {t(`mcpServers.policy.${policy}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One Factory a server is assigned to, optionally only some of its boards and phases. */
function AssignmentRow({
  assignment,
  factories,
  onChange,
  onRemove,
}: {
  assignment: McpServerAssignment;
  factories: Array<{ id: string; name: string }>;
  onChange: (next: McpServerAssignment) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const boards = useBoardCatalog(assignment.factoryProjectId || undefined).data ?? [];
  const chosenBoards = assignment.boards ?? [];
  const phases = boards
    .filter(board => chosenBoards.length === 0 || chosenBoards.includes(board.id))
    .flatMap(board => board.phases.filter(phase => phase.kind !== 'terminal').map(phase => ({ ...phase, board: board.name ?? board.id })));
  const toggle = (list: string[] | undefined, value: string) => {
    const next = (list ?? []).includes(value) ? (list ?? []).filter(item => item !== value) : [...(list ?? []), value];
    return next.length ? next : undefined;
  };
  const factoryName = factories.find(factory => factory.id === assignment.factoryProjectId)?.name;

  return (
    <div className="border-border1 flex flex-col gap-3 rounded-md border p-3" role="group" aria-label={t('mcpServers.access.row', { factory: factoryName ?? '—' })}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={assignment.factoryProjectId} onValueChange={factoryProjectId => onChange({ factoryProjectId })}>
          <SelectTrigger aria-label={t('mcpServers.access.factory')} className="w-56">
            {factoryName ?? t('mcpServers.access.pickFactory')}
          </SelectTrigger>
          <SelectContent>
            {factories.map(factory => (
              <SelectItem key={factory.id} value={factory.id}>
                {factory.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('mcpServers.access.remove')}
        </Button>
      </div>
      {boards.length > 0 && (
        <div className="flex flex-col gap-1">
          <Txt as="span" variant="caption" tone="muted">
            {chosenBoards.length ? t('mcpServers.access.boards') : t('mcpServers.access.allBoards')}
          </Txt>
          <div className="flex flex-wrap gap-1">
            {boards.map(board => (
              <Button
                key={board.id}
                size="sm"
                variant={chosenBoards.includes(board.id) ? 'default' : 'ghost'}
                aria-pressed={chosenBoards.includes(board.id)}
                onClick={() => onChange({ ...assignment, boards: toggle(assignment.boards, board.id), phases: undefined })}
              >
                {board.name ?? board.id}
              </Button>
            ))}
          </div>
        </div>
      )}
      {phases.length > 0 && (
        <div className="flex flex-col gap-1">
          <Txt as="span" variant="caption" tone="muted">
            {assignment.phases?.length ? t('mcpServers.access.phases') : t('mcpServers.access.allPhases')}
          </Txt>
          <div className="flex flex-wrap gap-1">
            {phases.map(phase => (
              <Button
                key={`${phase.board}:${phase.id}`}
                size="sm"
                variant={assignment.phases?.includes(phase.id) ? 'default' : 'ghost'}
                aria-pressed={assignment.phases?.includes(phase.id) ?? false}
                onClick={() => onChange({ ...assignment, phases: toggle(assignment.phases, phase.id) })}
              >
                {phase.name ?? phase.title ?? phase.id}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The form for a new server or a stored one: launch, secrets, access, tool policy, masking. */
function ServerEditor({
  server,
  presets,
  canEdit,
  onSaved,
}: {
  server?: McpServer;
  presets: McpServerPreset[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation('settings');
  const factories = (useFactoriesQuery().data ?? []).map(factory => ({ id: factory.id, name: factory.name }));
  const { save, remove, check } = useMcpServerMutations();
  const [draft, setDraft] = useState<McpServerInput>(() => (server ? serverToInput(server) : EMPTY));
  const [secretText, setSecretText] = useState<Record<string, string>>({});
  const [plainText, setPlainText] = useState(() => toLines(draft.launch.transport === 'stdio' ? draft.launch.env : draft.launch.headers));
  const [secretLines, setSecretLines] = useState('');
  const [status, setStatus] = useState<McpServerStatus>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const kind = kindOf(draft);
  const preset = presets.find(candidate => candidate.id === kind);
  const update = (patch: Partial<McpServerInput>) => setDraft(current => ({ ...current, ...patch }));

  const setKind = (next: string) => {
    if (next === HTTP) update({ launch: { transport: 'http', url: '', headers: {} } });
    else if (next === CUSTOM_STDIO) update({ launch: { transport: 'stdio', command: '', args: [], env: {} } });
    else update({ launch: { transport: 'stdio', preset: next, args: [], env: {} } });
    setPlainText('');
  };

  const secretKind = draft.launch.transport === 'http' ? 'headers' : 'env';
  const storedSecrets = server?.secretNames ?? { env: [], headers: [], files: [] };

  const submit = () => {
    const plain = parseLines(plainText);
    const launch =
      draft.launch.transport === 'http'
        ? { ...draft.launch, headers: plain }
        : { ...draft.launch, env: preset ? { ...draft.launch.env } : plain };
    const files = Object.fromEntries(Object.entries(secretText).filter(([, value]) => value.trim()));
    const lines = parseLines(secretLines);
    const secrets = {
      ...(Object.keys(files).length ? { files } : {}),
      ...(Object.keys(lines).length ? { [secretKind]: lines } : {}),
    };
    save.mutate(
      { ...draft, launch, ...(Object.keys(secrets).length ? { secrets } : {}), ...(server ? { id: server.id } : {}) },
      {
        onSuccess: () => {
          toast.success(t('mcpServers.saved'));
          setSecretText({});
          setSecretLines('');
          onSaved();
        },
        onError: error => toast.error(errorMessage(error)),
      },
    );
  };

  const runCheck = () => {
    if (!server) return;
    check.mutate(server.id, { onSuccess: setStatus, onError: error => toast.error(errorMessage(error)) });
  };

  const toolNames = [...new Set([...(status?.tools.map(tool => tool.name) ?? []), ...Object.keys(draft.toolPolicies.tools)])].sort();

  return (
    <SettingsContainer>
      <SettingsRow label={t('mcpServers.label')} description={t('mcpServers.labelHint')}>
        <Input aria-label={t('mcpServers.label')} value={draft.label} disabled={!canEdit} onChange={event => update({ label: event.target.value })} />
      </SettingsRow>
      <SettingsRow label={t('mcpServers.name')} description={t('mcpServers.nameHint')}>
        <Input aria-label={t('mcpServers.name')} value={draft.name} placeholder="syncta-db" disabled={!canEdit} onChange={event => update({ name: event.target.value })} />
      </SettingsRow>
      <SettingsRow label={t('mcpServers.kind')} description={preset?.description ?? t(`mcpServers.kindHint.${kind === HTTP ? 'http' : 'stdio'}`)}>
        <Select value={kind} onValueChange={setKind} disabled={!canEdit}>
          <SelectTrigger aria-label={t('mcpServers.kind')} className="w-72">
            {preset?.label ?? t(`mcpServers.kinds.${kind === HTTP ? 'http' : 'stdio'}`)}
          </SelectTrigger>
          <SelectContent>
            {presets.map(candidate => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_STDIO}>{t('mcpServers.kinds.stdio')}</SelectItem>
            <SelectItem value={HTTP}>{t('mcpServers.kinds.http')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>

      {preset &&
        draft.launch.transport === 'stdio' &&
        preset.env.map(variable => (
          <SettingsRow key={variable.name} label={variable.name} description={variable.label}>
            <Input
              aria-label={variable.name}
              value={draft.launch.transport === 'stdio' ? (draft.launch.env[variable.name] ?? '') : ''}
              disabled={!canEdit}
              onChange={event =>
                draft.launch.transport === 'stdio' &&
                update({ launch: { ...draft.launch, env: { ...draft.launch.env, [variable.name]: event.target.value } } })
              }
            />
          </SettingsRow>
        ))}
      {preset?.secretFiles.map(file => (
        <SettingsRow
          key={file.name}
          label={file.label}
          description={storedSecrets.files.includes(file.name) ? t('mcpServers.secretStored') : t('mcpServers.secretFileHint', { name: file.name })}
        >
          <Textarea
            aria-label={file.label}
            rows={3}
            placeholder={storedSecrets.files.includes(file.name) ? t('mcpServers.secretKeep') : ''}
            value={secretText[file.name] ?? ''}
            disabled={!canEdit}
            onChange={event => setSecretText(current => ({ ...current, [file.name]: event.target.value }))}
          />
        </SettingsRow>
      ))}

      {kind === CUSTOM_STDIO && draft.launch.transport === 'stdio' && (
        <>
          <SettingsRow label={t('mcpServers.command')} description={t('mcpServers.commandHint')}>
            <Input
              aria-label={t('mcpServers.command')}
              value={draft.launch.command ?? ''}
              disabled={!canEdit}
              onChange={event => draft.launch.transport === 'stdio' && update({ launch: { ...draft.launch, command: event.target.value } })}
            />
          </SettingsRow>
          <SettingsRow label={t('mcpServers.args')} description={t('mcpServers.argsHint')}>
            <Textarea
              aria-label={t('mcpServers.args')}
              rows={2}
              value={draft.launch.args.join('\n')}
              disabled={!canEdit}
              onChange={event =>
                draft.launch.transport === 'stdio' &&
                update({ launch: { ...draft.launch, args: event.target.value.split('\n').filter(Boolean) } })
              }
            />
          </SettingsRow>
        </>
      )}
      {kind === HTTP && draft.launch.transport === 'http' && (
        <SettingsRow label="URL" description={t('mcpServers.urlHint')}>
          <Input
            aria-label="URL"
            value={draft.launch.url}
            disabled={!canEdit}
            onChange={event => draft.launch.transport === 'http' && update({ launch: { ...draft.launch, url: event.target.value } })}
          />
        </SettingsRow>
      )}
      {!preset && (
        <>
          <SettingsRow label={t(`mcpServers.plain.${secretKind}`)} description={t('mcpServers.plainHint')}>
            <Textarea aria-label={t(`mcpServers.plain.${secretKind}`)} rows={2} value={plainText} disabled={!canEdit} onChange={event => setPlainText(event.target.value)} />
          </SettingsRow>
          <SettingsRow
            label={t(`mcpServers.secret.${secretKind}`)}
            description={
              storedSecrets[secretKind].length
                ? t('mcpServers.secretNames', { names: storedSecrets[secretKind].join(', ') })
                : t('mcpServers.secretLinesHint')
            }
          >
            <Textarea aria-label={t(`mcpServers.secret.${secretKind}`)} rows={2} value={secretLines} disabled={!canEdit} onChange={event => setSecretLines(event.target.value)} />
          </SettingsRow>
        </>
      )}

      <SettingsRow label={t('mcpServers.access.title')} description={t('mcpServers.access.hint')}>
        <div className="flex w-full flex-col gap-2">
          {draft.assignments.length === 0 && (
            <Txt as="p" variant="caption" tone="muted">
              {t('mcpServers.access.none')}
            </Txt>
          )}
          {draft.assignments.map((assignment, index) => (
            <AssignmentRow
              key={index}
              assignment={assignment}
              factories={factories}
              onChange={next => update({ assignments: draft.assignments.map((item, at) => (at === index ? next : item)) })}
              onRemove={() => update({ assignments: draft.assignments.filter((_, at) => at !== index) })}
            />
          ))}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => update({ assignments: [...draft.assignments, { factoryProjectId: factories[0]?.id ?? '' }] })}
            >
              {t('mcpServers.access.add')}
            </Button>
          )}
        </div>
      </SettingsRow>

      <SettingsRow label={t('mcpServers.tools.default')} description={t('mcpServers.tools.defaultHint')}>
        <PolicySelect
          label={t('mcpServers.tools.default')}
          value={draft.toolPolicies.default}
          onChange={value => update({ toolPolicies: { ...draft.toolPolicies, default: value } })}
        />
      </SettingsRow>
      <SettingsRow label={t('mcpServers.tools.title')} description={server ? t('mcpServers.tools.hint') : t('mcpServers.tools.saveFirst')}>
        <div className="flex w-full flex-col gap-2">
          {server && (
            <Button size="sm" variant="ghost" className="self-start" disabled={check.isPending} onClick={runCheck}>
              {check.isPending ? t('mcpServers.checking') : t('mcpServers.check')}
            </Button>
          )}
          {status && (
            <Txt as="p" variant="caption" tone="muted" className={status.connected ? undefined : 'text-destructive-foreground'} role="status">
              {status.connected ? t('mcpServers.status.connected', { count: status.toolCount }) : t('mcpServers.status.failed', { error: status.error ?? '' })}
            </Txt>
          )}
          {toolNames.map(tool => {
            const own = draft.toolPolicies.tools[tool];
            return (
              <div key={tool} className="flex flex-wrap items-center justify-between gap-2">
                <Txt as="span" variant="body" tone="ink" className="font-mono">
                  {tool}
                  {preset?.writeTools.includes(tool) && (
                    <Badge size="xs" variant="neutral" className="ml-2">
                      {t('mcpServers.tools.writes')}
                    </Badge>
                  )}
                </Txt>
                <PolicySelect
                  label={t('mcpServers.tools.policyFor', { tool })}
                  value={own ?? draft.toolPolicies.default}
                  onChange={value => {
                    const tools = { ...draft.toolPolicies.tools };
                    if (value === draft.toolPolicies.default) delete tools[tool];
                    else tools[tool] = value;
                    update({ toolPolicies: { ...draft.toolPolicies, tools } });
                  }}
                />
              </div>
            );
          })}
        </div>
      </SettingsRow>

      <SettingsRow label={t('mcpServers.mask')} description={t('mcpServers.maskHint')}>
        <Switch aria-label={t('mcpServers.mask')} checked={draft.maskPersonalData} disabled={!canEdit} onCheckedChange={maskPersonalData => update({ maskPersonalData })} />
      </SettingsRow>
      <SettingsRow label={t('mcpServers.enabled')} description={t('mcpServers.enabledHint')}>
        <Switch aria-label={t('mcpServers.enabled')} checked={draft.enabled} disabled={!canEdit} onCheckedChange={enabled => update({ enabled })} />
      </SettingsRow>

      {canEdit && (
        <div className="flex gap-2">
          <Button size="sm" disabled={save.isPending || !draft.name || !draft.label} onClick={submit}>
            {t('mcpServers.save')}
          </Button>
          {server && (
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

function ServerCard({ server, presets, canEdit }: { server: McpServer; presets: McpServerPreset[]; canEdit: boolean }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const kind = server.launch.transport === 'http' ? t('mcpServers.kinds.http') : (presets.find(preset => preset.id === (server.launch as { preset?: string }).preset)?.label ?? t('mcpServers.kinds.stdio'));
  const summary = [
    server.name,
    kind,
    server.assignments.length ? t('mcpServers.summary.factories', { count: server.assignments.length }) : t('mcpServers.summary.unassigned'),
    ...(server.enabled ? [] : [t('mcpServers.summary.off')]),
  ].join(' · ');
  return (
    <SourceItemCard title={server.label} summary={summary} open={open} onOpenChange={setOpen}>
      <ServerEditor server={server} presets={presets} canEdit={canEdit} onSaved={() => {}} />
    </SourceItemCard>
  );
}

/**
 * Settings › MCP-сервери — the MCP manager: the organization's external MCP servers (a database through
 * MCP Toolbox, …), which Factories' cards get each one (Factory, boards, phases), what each of its tools
 * may do (allow / ask / deny) and whether personal data in results is masked.
 */
export function McpServersSection() {
  const { t } = useTranslation('settings');
  const query = useMcpServersQuery();
  const [adding, setAdding] = useState(false);
  const state = query.data;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSubsection
        title={t('mcpServers.title')}
        description={t('mcpServers.description')}
        scope="org"
        action={
          state?.canEdit ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              {t('mcpServers.add')}
            </Button>
          ) : undefined
        }
      >
        {query.isPending && (
          <Txt as="p" variant="caption" tone="muted">
            {t('mcpServers.loading')}
          </Txt>
        )}
        {query.isError && (
          <Txt as="p" variant="caption" className="text-destructive-foreground">
            {errorMessage(query.error)}
          </Txt>
        )}
        {state && state.servers.length === 0 && !adding && (
          <Txt as="p" variant="caption" tone="muted">
            {t('mcpServers.empty')}
          </Txt>
        )}
        {adding && state && (
          <SourceItemCard title={t('mcpServers.newServer')} summary="" open onOpenChange={open => !open && setAdding(false)}>
            <ServerEditor presets={state.presets} canEdit onSaved={() => setAdding(false)} />
          </SourceItemCard>
        )}
        <div className="flex flex-col gap-3">
          {state?.servers.map(server => (
            <ServerCard key={server.id} server={server} presets={state.presets} canEdit={state.canEdit} />
          ))}
        </div>
      </SettingsSubsection>
    </div>
  );
}
