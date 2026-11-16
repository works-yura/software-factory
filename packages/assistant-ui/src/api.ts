/**
 * The panel's client of `/web/assistant/*` (ADR-0051) and its React Query hooks. The app gives the
 * base URL; requests carry the browser's session cookie. A refusal throws its server message, so
 * the panel shows it instead of a generic failure.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, useContext, useMemo } from 'react';
import type { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import type { ComponentProps, ComponentType, ReactNode } from 'react';

export type RequestStatus = 'new' | 'waiting_factory' | 'waiting_me' | 'answered' | 'closed';
export const REQUEST_STATUSES: readonly RequestStatus[] = ['new', 'waiting_factory', 'waiting_me', 'answered', 'closed'];

export interface FactoryLink {
  factoryId: string;
  factoryName: string;
  sessionId?: string;
  workItemId?: string;
  url?: string;
}

/** What kind of failure an agent turn hit: the thread explains each with its own fix. */
export type TurnFailureKind = 'no_model' | 'rate_limit' | 'auth' | 'model_not_found' | 'overloaded' | 'unknown';

/** Why the agent's last turn failed: the model it ran on, the kind, the provider's raw words. */
export interface TurnFailure {
  kind: TurnFailureKind;
  modelId: string | null;
  status: number | null;
  detail: string;
}

interface PendingActionBase {
  id: string;
  reason?: string;
  proposedBy: 'agent' | 'rule';
  proposedAt: string;
}

/** A Factory action the agent (or a channel rule) proposed: waits for the person's Confirm / Cancel. */
export interface FactoryPendingAction extends PendingActionBase {
  kind: 'ask' | 'hand_over';
  factoryId: string;
  factoryName: string;
  question?: string;
  title?: string;
  note?: string;
  workspaceFiles?: string[];
}

/** A workspace call (a command, an edit) the permission rules ask about: runs exactly as shown once confirmed. */
export interface WorkspaceToolPendingAction extends PendingActionBase {
  kind: 'workspace_tool';
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
}

/** A download from a host none of the person's sources owns: fetched without credentials once confirmed. */
export interface DownloadPendingAction extends PendingActionBase {
  kind: 'download';
  url: string;
  name: string;
}

export type PendingAction = FactoryPendingAction | WorkspaceToolPendingAction | DownloadPendingAction;

/** One entry of a request's workspace folder (`GET …/workspace`). */
export interface WorkspaceEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  mime: string | null;
  modifiedAt: string | null;
}

/** One tool call of an agent turn: short summaries of what went in and came out. */
export interface ToolCallRecord {
  name: string;
  args: string;
  result?: string;
  error?: string;
  durationMs: number;
}

/** What drove one agent reply: the model, the system prompt's version, the skills, the tool calls. */
export interface TurnDetails {
  modelId: string | null;
  instructionsVersion: string;
  skills: string[];
  toolCalls: ToolCallRecord[];
  durationMs: number;
}

export interface AssistantRequest {
  id: string;
  topic: string;
  fromName: string | null;
  source: string;
  sourceUrl: string | null;
  /** The closed request of the same source thread this one continues (phase 2 sources). */
  previousRequestId?: string | null;
  status: RequestStatus;
  factory: FactoryLink | null;
  analysing: boolean;
  lastError: TurnFailure | null;
  unread: boolean;
  /** Absent from servers before phase 3. */
  pendingAction?: PendingAction | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AssistantMessage {
  id: string;
  author: 'person' | 'agent' | 'factory' | 'event' | 'source';
  /** Who wrote a `source` entry (a colleague in ClickUp); `null` otherwise. */
  fromName?: string | null;
  text: string;
  fileIds: string[];
  /** On an agent reply: what drove it (absent on older replies). */
  details?: TurnDetails | null;
  createdAt: string;
}

export interface AssistantFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  contentUrl: string;
}

export interface RequestView {
  request: AssistantRequest;
  messages: AssistantMessage[];
  files: AssistantFile[];
}

export interface AssistantNote {
  id: string;
  requestId: string | null;
  text: string;
  author: 'person' | 'agent';
  createdAt: string;
  updatedAt: string;
}

export type DigestFrequency = 'off' | 'hourly' | 'daily';

export interface DigestSettings {
  frequency: DigestFrequency;
  hour: number;
  timeZone: string;
}

export interface AssistantSettings {
  modelId: string | null;
  retentionDays: number;
  /** Skill names the agent may load (absent from servers before phase 3). */
  skills?: string[];
  digest?: DigestSettings;
}

/**
 * A model of the organization's. The server may add how Factory presents it (a label, a group such
 * as a sign-in account, a free badge, whether it can run now); the picker reads what is there.
 */
export interface AssistantModel {
  id: string;
  provider: string;
  modelName: string;
  label?: string;
  group?: string;
  free?: boolean;
  available?: boolean;
  unavailableReason?: string;
}

/** The model a person who chose none runs on, and why (when the server says). */
export interface AssistantDefaultModel {
  modelId: string | null;
  label?: string;
  source?: string;
  reason?: string;
}

/** Whether a group (or a model) can run now, as Factory's catalog says. */
export interface ModelAvailability {
  state: 'ready' | 'limited' | 'no_credentials' | 'sessions_only' | 'unavailable';
  until?: string;
  reason?: string;
  connector?: string;
}

export interface ModelGroupModel {
  id: string;
  label: string;
  provider?: string;
  modelName?: string;
  free?: boolean;
  legacy?: boolean;
  selectable: boolean;
  availability?: ModelAvailability;
}

/** The organization's models as Factory presents them: by harness and credential (Claude sign-in, an API key …). */
export interface ModelGroup {
  id: string;
  harness?: string;
  harnessLabel?: string;
  provider?: string;
  label: string;
  credential?: string;
  credentialLabel?: string;
  availability?: ModelAvailability;
  models: ModelGroupModel[];
}

export interface AssistantModelCatalog {
  models: AssistantModel[];
  /** Absent from servers that list models only. */
  groups: ModelGroup[];
  default: AssistantDefaultModel | null;
  /** The response as the server sent it, for a host picker that reads more of it (provider instances). */
  raw: Record<string, unknown>;
}

export interface FactoryAccessState {
  connected: boolean;
  pending: boolean;
  factories: Array<{ id: string; name: string }>;
}

export class AssistantApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'AssistantApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The host app's Files for a request's workspace folder (ADR-0051): the same panel, file links and
 * download a Factory session has, which live in the app, so the app hands them in (as it hands in
 * the model picker). Without it the thread shows no Files.
 */
export interface AssistantWorkspaceSlot {
  /**
   * Wraps one request's thread: the app's Files card beside it, reading the request's folder. Its
   * `revision` changes whenever the thread does, so the folder is read again after a turn.
   */
  Thread: ComponentType<{ requestId: string; revision: string; children: ReactNode }>;
  /** The Files toggle for the thread's header (inside `Thread`). */
  Toggle: ComponentType;
  /** Markdown overrides inside `Thread`: file paths in the agent's text open the file there. */
  useMarkdown(): Pick<ComponentProps<typeof MarkdownRenderer>, 'components' | 'remarkPlugins'>;
}

export interface AssistantApi {
  baseUrl: string;
  /** The app's Account › «Помічник» page (its model picker), when the host knows it. */
  settingsHref?: string;
  /** The app's Files for a request's workspace. */
  workspace?: AssistantWorkspaceSlot;
}

const AssistantApiContext = createContext<AssistantApi | null>(null);

/** Gives the panel the server's base URL (`''` for same-origin) and, when known, where its settings live. */
export function AssistantApiProvider({
  baseUrl,
  settingsHref,
  workspace,
  children,
}: {
  baseUrl: string;
  settingsHref?: string;
  workspace?: AssistantWorkspaceSlot;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ baseUrl, ...(settingsHref ? { settingsHref } : {}), ...(workspace ? { workspace } : {}) }),
    [baseUrl, settingsHref, workspace],
  );
  return createElement(AssistantApiContext.Provider, { value }, children);
}

export function useAssistantApi(): AssistantApi {
  const api = useContext(AssistantApiContext);
  if (!api) throw new Error('The assistant panel needs an AssistantApiProvider.');
  return api;
}

/** An absolute URL for a server path (file content, for `<img>` and links). */
export function assistantUrl(api: AssistantApi, path: string): string {
  return `${api.baseUrl}${path}`;
}

export async function call<T>(api: AssistantApi, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${api.baseUrl}/web/assistant${path}`, { credentials: 'include', ...init });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `The assistant answered ${response.status}.`;
    throw new AssistantApiError(response.status, typeof body.error === 'string' ? body.error : undefined, message);
  }
  return body as T;
}

export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** A message with files goes as multipart; the browser sets its boundary. */
function messageForm(input: { text: string; fromName?: string; sourceUrl?: string; files: File[] }): RequestInit {
  if (input.files.length === 0) {
    return json('POST', {
      text: input.text,
      ...(input.fromName ? { fromName: input.fromName } : {}),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    });
  }
  const form = new FormData();
  form.set('text', input.text);
  if (input.fromName) form.set('fromName', input.fromName);
  if (input.sourceUrl) form.set('sourceUrl', input.sourceUrl);
  for (const file of input.files) form.append('files', file, file.name);
  return { method: 'POST', body: form };
}

export const assistantKeys = {
  all: ['assistant'] as const,
  requests: () => ['assistant', 'requests'] as const,
  request: (id: string) => ['assistant', 'request', id] as const,
  notes: () => ['assistant', 'notes'] as const,
  settings: () => ['assistant', 'settings'] as const,
  models: () => ['assistant', 'models'] as const,
  factories: () => ['assistant', 'factories'] as const,
  behavior: () => ['assistant', 'behavior'] as const,
  skills: () => ['assistant', 'skills'] as const,
  skill: (name: string) => ['assistant', 'skill', name] as const,
  preview: () => ['assistant', 'agent-preview'] as const,
  modelStatus: () => ['assistant', 'model-status'] as const,
};

export function useAssistantRequests(options: { enabled?: boolean } = {}) {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.requests(),
    queryFn: () => call<{ requests: AssistantRequest[] }>(api, '/requests').then(body => body.requests),
    enabled: options.enabled ?? true,
    // While the agent works on any request, follow it; otherwise look now and then for news.
    refetchInterval: query => (query.state.data?.some(request => request.analysing) ? 2_000 : 30_000),
  });
}

export function useAssistantRequest(id: string | undefined) {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.request(id ?? ''),
    queryFn: () => call<RequestView>(api, `/requests/${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    refetchInterval: query => (query.state.data?.request.analysing ? 1_500 : false),
  });
}

/** The request's workspace folder, flat (what a hand-over can attach); `available: false` without a workspace. */
export function useRequestWorkspace(id: string, options: { enabled?: boolean } = {}) {
  const api = useAssistantApi();
  return useQuery({
    queryKey: [...assistantKeys.request(id), 'workspace'] as const,
    queryFn: () =>
      call<{ workspace: { available: boolean; files: WorkspaceEntry[] } }>(api, `/requests/${encodeURIComponent(id)}/workspace`).then(
        body => body.workspace,
      ),
    enabled: options.enabled ?? true,
  });
}

function useInvalidateRequests() {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: assistantKeys.requests() });
    if (id) void queryClient.invalidateQueries({ queryKey: assistantKeys.request(id) });
  };
}

export function useCreateRequest() {
  const api = useAssistantApi();
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (input: { text: string; fromName?: string; sourceUrl?: string; files: File[] }) =>
      call<{ request: AssistantRequest }>(api, '/requests', messageForm(input)).then(body => body.request),
    onSuccess: request => invalidate(request.id),
  });
}

export function usePostMessage(id: string) {
  const api = useAssistantApi();
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (input: { text: string; files: File[] }) =>
      call<{ request: AssistantRequest }>(api, `/requests/${encodeURIComponent(id)}/messages`, messageForm(input)),
    onSuccess: () => invalidate(id),
  });
}

export interface RequestPatch {
  topic?: string;
  status?: RequestStatus;
}

/**
 * The person's own edits to any request (topic, status) — the thread header and the list's
 * keyboard (E closes) both use it. The list shows the new status at once, before the server answers.
 */
export function useUpdateRequest() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RequestPatch }) =>
      call<{ request: AssistantRequest }>(api, `/requests/${encodeURIComponent(id)}`, json('PATCH', patch)).then(body => body.request),
    onMutate: ({ id, patch }) => {
      queryClient.setQueryData<AssistantRequest[]>(assistantKeys.requests(), current =>
        current?.map(request => (request.id === id ? { ...request, ...patch } : request)),
      );
      queryClient.setQueryData<RequestView>(assistantKeys.request(id), current =>
        current ? { ...current, request: { ...current.request, ...patch } } : current,
      );
    },
    onSettled: (_data, _error, { id }) => invalidate(id),
  });
}

/**
 * Deletes requests for good (their threads, notes, memory and files), one call each, then drops them
 * from the list. Used for one request from its menu and for every request a filter shows.
 */
export function useDeleteRequests() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await call(api, `/requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    onSettled: (_data, _error, ids) => {
      for (const id of ids) queryClient.removeQueries({ queryKey: assistantKeys.request(id) });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.requests() });
    },
  });
}

export function useRequestAction(id: string) {
  const api = useAssistantApi();
  const invalidate = useInvalidateRequests();
  const path = `/requests/${encodeURIComponent(id)}`;
  const done = { onSuccess: () => invalidate(id) };
  return {
    close: useMutation({ mutationFn: () => call(api, `${path}/close`, json('POST', {})), ...done }),
    ask: useMutation({
      mutationFn: (input: { factoryId: string; question?: string }) => call(api, `${path}/ask`, json('POST', input)),
      ...done,
    }),
    handOver: useMutation({
      mutationFn: (input: { factoryId: string; title?: string; note?: string; workspaceFiles?: string[] }) =>
        call(api, `${path}/hand-over`, json('POST', input)),
      ...done,
    }),
    /** Runs the agent again on what it has not answered (a failed turn, messages left unread by a limit). */
    retry: useMutation({
      mutationFn: () => call<{ request: AssistantRequest }>(api, `${path}/retry`, json('POST', {})),
      ...done,
    }),
    checkAnswer: useMutation({
      mutationFn: () => call<{ answered: boolean }>(api, `${path}/check-answer`, json('POST', {})),
      ...done,
    }),
  };
}

export function useAssistantFactories(options: { enabled?: boolean } = {}) {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.factories(),
    queryFn: () => call<FactoryAccessState>(api, '/factories'),
    enabled: options.enabled ?? true,
    retry: false,
  });
}

export function useAssistantNotes() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.notes(),
    queryFn: () => call<{ notes: AssistantNote[] }>(api, '/notes').then(body => body.notes),
  });
}

export function useNoteActions() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  const done = { onSuccess: () => void queryClient.invalidateQueries({ queryKey: assistantKeys.notes() }) };
  return {
    create: useMutation({
      mutationFn: (input: { text: string; requestId?: string | null }) =>
        call<{ note: AssistantNote }>(api, '/notes', json('POST', input.requestId ? input : { text: input.text })).then(body => body.note),
      ...done,
    }),
    update: useMutation({
      mutationFn: (input: { id: string; text: string }) =>
        call<{ note: AssistantNote }>(api, `/notes/${encodeURIComponent(input.id)}`, json('PATCH', { text: input.text })).then(
          body => body.note,
        ),
      ...done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => call(api, `/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      ...done,
    }),
  };
}

export function useAssistantSettings() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.settings(),
    queryFn: () => call<{ settings: AssistantSettings }>(api, '/settings').then(body => body.settings),
  });
}

/** Confirm or Cancel a proposed Factory action in a thread. */
export function usePendingAction(requestId: string) {
  const api = useAssistantApi();
  const invalidate = useInvalidateRequests();
  const path = (actionId: string, verb: 'confirm' | 'cancel') =>
    `/requests/${encodeURIComponent(requestId)}/actions/${encodeURIComponent(actionId)}/${verb}`;
  const done = { onSettled: () => invalidate(requestId) };
  return {
    confirm: useMutation({ mutationFn: (actionId: string) => call(api, path(actionId, 'confirm'), json('POST', {})), ...done }),
    cancel: useMutation({ mutationFn: (actionId: string) => call(api, path(actionId, 'cancel'), json('POST', {})), ...done }),
  };
}

/** `GET /models` as the picker reads it: the list, and the default with its reason when the server gives one. */
export function readModelCatalog(body: Record<string, unknown>): AssistantModelCatalog {
  const models = Array.isArray(body.models) ? (body.models as AssistantModel[]) : [];
  const groups = Array.isArray(body.groups) ? (body.groups as ModelGroup[]).filter(group => Array.isArray(group?.models)) : [];
  const raw = (body.default ?? body.defaultModel) as Record<string, unknown> | string | null | undefined;
  const defaultModel =
    typeof raw === 'string'
      ? { modelId: raw }
      : raw && typeof raw === 'object'
        ? {
            modelId: typeof raw.modelId === 'string' ? raw.modelId : typeof raw.id === 'string' ? raw.id : null,
            ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
            ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
            ...(typeof raw.reason === 'string'
              ? { reason: raw.reason }
              : typeof body.defaultReason === 'string'
                ? { reason: body.defaultReason }
                : {}),
          }
        : null;
  return { models, groups, default: defaultModel, raw: body };
}

export function useAssistantModelCatalog() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.models(),
    queryFn: () => call<Record<string, unknown>>(api, '/models').then(readModelCatalog),
  });
}

/** A model id as the catalog names it (`Claude Code · Opus 5.5`), else as `modelLabel` spells the id. */
export function catalogModelLabel(catalog: AssistantModelCatalog | undefined, modelId: string): string | undefined {
  if (!catalog) return undefined;
  for (const group of catalog.groups) {
    const model = group.models.find(candidate => candidate.id === modelId);
    if (model) return model.label.includes(group.label) ? model.label : `${group.label} · ${model.label}`;
  }
  return catalog.models.find(model => model.id === modelId)?.label;
}

export function useAssistantModels() {
  const catalog = useAssistantModelCatalog();
  return { ...catalog, data: catalog.data?.models } as Omit<typeof catalog, 'data'> & { data: AssistantModel[] | undefined };
}

export function useSettingsActions() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  return {
    save: useMutation({
      mutationFn: (patch: Partial<AssistantSettings>) =>
        call<{ settings: AssistantSettings }>(api, '/settings', json('PUT', patch)).then(body => body.settings),
      onSuccess: settings => {
        queryClient.setQueryData(assistantKeys.settings(), settings);
        void queryClient.invalidateQueries({ queryKey: [...assistantKeys.settings(), 'schedule'] });
        void queryClient.invalidateQueries({ queryKey: assistantKeys.skills() });
        void queryClient.invalidateQueries({ queryKey: assistantKeys.preview() });
      },
    }),
    clear: useMutation({
      mutationFn: () => call<{ cleared: { requests: number; files: number } }>(api, '/clear', json('POST', {})),
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: assistantKeys.all }),
    }),
    startAccess: useMutation({
      mutationFn: (returnTo: string) => call<{ url: string }>(api, '/factory-access/start', json('POST', { returnTo })),
    }),
    disconnect: useMutation({
      mutationFn: () => call(api, '/factory-access', { method: 'DELETE' }),
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: assistantKeys.factories() }),
    }),
  };
}
