/**
 * The panel's client of `/web/assistant/*` (ADR-0051) and its React Query hooks. The app gives the
 * base URL; requests carry the browser's session cookie. A refusal throws its server message, so
 * the panel shows it instead of a generic failure.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, createElement, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

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

export interface AssistantSettings {
  modelId: string | null;
  retentionDays: number;
}

export interface AssistantModel {
  id: string;
  provider: string;
  modelName: string;
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

export interface AssistantApi {
  baseUrl: string;
  /** The app's Account › «Помічник» page (its model picker), when the host knows it. */
  settingsHref?: string;
}

const AssistantApiContext = createContext<AssistantApi | null>(null);

/** Gives the panel the server's base URL (`''` for same-origin) and, when known, where its settings live. */
export function AssistantApiProvider({
  baseUrl,
  settingsHref,
  children,
}: {
  baseUrl: string;
  settingsHref?: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ baseUrl, ...(settingsHref ? { settingsHref } : {}) }), [baseUrl, settingsHref]);
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
      mutationFn: (input: { factoryId: string; title?: string; note?: string }) => call(api, `${path}/hand-over`, json('POST', input)),
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

export function useAssistantModels() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.models(),
    queryFn: () => call<{ models: AssistantModel[] }>(api, '/models').then(body => body.models),
  });
}

export function useSettingsActions() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  return {
    save: useMutation({
      mutationFn: (patch: Partial<AssistantSettings>) =>
        call<{ settings: AssistantSettings }>(api, '/settings', json('PUT', patch)).then(body => body.settings),
      onSuccess: settings => queryClient.setQueryData(assistantKeys.settings(), settings),
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
