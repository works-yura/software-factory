import { randomUUID } from 'node:crypto';

/**
 * The HTTP calls the web UI makes to set up a Claude Code Factory and chat in
 * it (see apps/ui/src/ui/domains/workspaces/services and hooks/useFactories),
 * against a local-dev-auth server (loopback callers are signed in).
 */

export const CONTROLLER_ID = 'code';

export async function api<T = unknown>(baseUrl: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? (init.body === undefined ? 'GET' : 'POST')} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface ClaudeFactory {
  factoryId: string;
  projectRepositoryId: string;
}

/**
 * Creates a Claude Code Factory with the fake GitLab project linked, the way
 * the New Factory wizard does: register the GitLab project, create the
 * Factory, connect the installation, link the repository.
 */
export async function createClaudeFactory(
  baseUrl: string,
  { name, projectId, claudeCodeModel = 'haiku' }: { name: string; projectId: number; claudeCodeModel?: string | null },
): Promise<ClaudeFactory> {
  const { projects } = await api<{ projects: Array<{ id: string; projectId: string; projectPath: string; defaultBranch: string }> }>(
    baseUrl,
    '/web/gitlab/projects',
  );
  const source = projects.find(project => project.projectId === String(projectId));
  if (!source) throw new Error(`GitLab project ${projectId} is not listed: ${JSON.stringify(projects)}`);
  const { project: registered } = await api<{
    project: { installationStorageId: string; projectPath: string; defaultBranch: string; sandboxProvider: string; sandboxWorkdir: string };
  }>(baseUrl, '/web/gitlab/projects/registration', { body: { sourceId: source.id } });

  const { project: factory } = await api<{ project: { id: string; harness: string } }>(baseUrl, '/web/factory/projects', {
    body: { name, harness: 'claude-code', claudeCodeModel },
  });
  if (factory.harness !== 'claude-code') throw new Error(`Factory was created on ${factory.harness}`);

  const { connection } = await api<{ connection: { id: string } }>(
    baseUrl,
    `/web/factory/projects/${encodeURIComponent(factory.id)}/source-control-connections`,
    { body: { integrationId: 'gitlab', installationId: registered.installationStorageId } },
  );
  const { projectRepository } = await api<{ projectRepository: { id: string } }>(
    baseUrl,
    `/web/factory/projects/${encodeURIComponent(factory.id)}/source-control-connections/${encodeURIComponent(connection.id)}/repositories`,
    {
      body: {
        repository: { externalId: String(projectId), slug: registered.projectPath },
        branch: registered.defaultBranch,
        sandboxProvider: registered.sandboxProvider,
        sandboxWorkdir: registered.sandboxWorkdir,
      },
    },
  );
  return { factoryId: factory.id, projectRepositoryId: projectRepository.id };
}

export interface ChatSession {
  sessionId: string;
  harness?: string;
}

/** New session in the chat: a private personal session on the linked repository. */
export async function createChat(baseUrl: string, projectRepositoryId: string, title: string): Promise<ChatSession> {
  const sessionId = randomUUID();
  const { session } = await api<{ session: ChatSession }>(
    baseUrl,
    `/web/source-control/projects/${encodeURIComponent(projectRepositoryId)}/sessions`,
    { body: { sessionId, title, visibility: 'private' } },
  );
  return session;
}

const sessionPath = (sessionId: string) => `/api/agent-controller/${CONTROLLER_ID}/sessions/${encodeURIComponent(sessionId)}`;

export async function sendMessage(baseUrl: string, sessionId: string, message: string): Promise<void> {
  await api(baseUrl, `${sessionPath(sessionId)}/messages`, { body: { message } });
}

export async function answerToolApproval(baseUrl: string, sessionId: string, toolCallId: string, approved: boolean) {
  return api<{ ok: boolean; reason?: string }>(baseUrl, `${sessionPath(sessionId)}/tool-approval`, {
    body: { toolCallId, approved },
  });
}

export interface DisplayState {
  isRunning: boolean;
  pendingApprovals: Record<string, { toolCallId: string; toolName: string; args: unknown }>;
  pendingSuspensions: Record<string, unknown>;
}

/** The session's display state: the first event its stream sends. */
export async function displayState(baseUrl: string, sessionId: string): Promise<DisplayState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${baseUrl}${sessionPath(sessionId)}/stream`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`stream -> ${res.status}: ${await res.text()}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed before the display state');
      buffer += decoder.decode(value, { stream: true });
      const end = buffer.indexOf('\n\n');
      if (end === -1) continue;
      for (const line of buffer.slice(0, end).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6)) as { type: string; displayState?: DisplayState };
        if (event.type === 'display_state_changed' && event.displayState) return event.displayState;
      }
      buffer = buffer.slice(end + 2);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface WireMessage {
  id: string;
  role: string;
  content: { parts?: Array<Record<string, unknown>> } & Record<string, unknown>;
}

export async function threadMessages(baseUrl: string, sessionId: string): Promise<WireMessage[]> {
  const { messages } = await api<{ messages: WireMessage[] }>(
    baseUrl,
    `${sessionPath(sessionId)}/threads/${encodeURIComponent(sessionId)}/messages?perPage=200`,
  );
  return messages;
}

export async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 120_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`);
}

export interface ToolInvocation {
  toolCallId?: string;
  toolName: string;
  state: string;
  result?: unknown;
}

/** Every tool call in a thread's stored messages (the `tool-invocation` parts). */
export function toolInvocations(messages: WireMessage[]): ToolInvocation[] {
  return messages.flatMap(message =>
    (message.content.parts ?? []).flatMap(part =>
      part.type === 'tool-invocation' && part.toolInvocation ? [part.toolInvocation as ToolInvocation] : [],
    ),
  );
}
