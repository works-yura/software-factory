/**
 * GitLab's connections facet (ADR-0035), on Mastra Factory's platform-connect model: in Platform mode
 * every GitLab account the organization connected through Mastra Platform is a connection, added and
 * reauthorized with an `oauth` method whose result is a Nango connect session the browser completes
 * headlessly (`getAuthStatus` then says when the account is active); in direct mode the server's own
 * `GITLAB_ACCESS_TOKEN` is the one connection, changed only in the environment. Names and removal
 * live on Mastra Platform, so those actions say so. Everything the person reads is written here.
 */

import { connectionOk, connectionRefused, localize } from '@factory/integrations';
import type {
  AuthFlowStatus,
  ConnectionCopy,
  ConnectionDetailSection,
  ConnectionOutcome,
  ConnectionRequest,
  ConnectMethod,
  ConnectorConnection,
  ConnectorConnectResult,
  IntegrationConnections,
} from '@factory/integrations';

import type { GitLabStatusConnection } from './integration.ts';

/** Mastra Platform's console, where Platform connections are renamed and removed. */
export const MASTRA_PLATFORM_URL = 'https://projects.mastra.ai';

/** A Nango connect or reconnect session minted with the deploy's Platform credentials. */
export interface GitLabPlatformSession {
  connectionId: string;
  integrationId: string;
  sessionToken: string;
  expiresAt: string;
}

/** What the facet needs from a GitLab integration, either mode. */
export interface GitLabConnectionsSource {
  diagnostics(): Record<string, unknown>;
  /** Platform mode: the organization's connections; direct mode: undefined. */
  statusConnections(): Promise<Array<GitLabStatusConnection & { displayName?: string | null }> | undefined>;
  /** Direct mode: checks the configured token (throws when GitLab refuses it). */
  verifyStatus(): Promise<void>;
  /** Platform mode: mints connect and reconnect sessions; direct mode: undefined. */
  platformSessions(): { connect(): Promise<GitLabPlatformSession>; reconnect(connectionId: string): Promise<GitLabPlatformSession> } | undefined;
}

interface Copy {
  name: string;
  summary: string;
  provides: { repositories: string; tasks: string };
  platform: { label: string; description: string };
  direct: { label: string; reason: string; method: string; state: string; changeInEnv: string };
  method: string;
  state: { connected: string; reauth: string; reauthMessage: string; refused: string };
  platformOnly: string;
  manage: string;
  notFound: string;
  sessionFailed: (error: string) => string;
  detail: { host: string; mode: string; modes: { platform: string; direct: string } };
}

const COPY: ConnectionCopy<Copy> = {
  en: {
    name: 'GitLab',
    summary: 'GitLab repositories and issues.',
    provides: { repositories: 'Repositories', tasks: 'Issues and merge requests' },
    platform: {
      label: 'GitLab account',
      description: 'Sign in to GitLab in a popup; Mastra Platform keeps the connection for your organization.',
    },
    direct: {
      label: 'Access token',
      reason: 'This server connects GitLab with its own GITLAB_ACCESS_TOKEN; it is changed in the server environment.',
      method: 'Server token',
      state: 'From the server environment',
      changeInEnv: 'Set in the server environment — change the environment variables',
    },
    method: 'Mastra Platform',
    state: { connected: 'Connected', reauth: 'Needs sign-in', reauthMessage: 'GitLab asks to sign in again: use «Reconnect».', refused: 'GitLab refuses the token' },
    platformOnly: 'Managed on Mastra Platform',
    manage: 'Open Mastra Platform',
    notFound: 'This GitLab connection no longer exists.',
    sessionFailed: error => `Mastra Platform could not start the GitLab sign-in: ${error}`,
    detail: { host: 'GitLab', mode: 'Connected through', modes: { platform: 'Mastra Platform', direct: 'the server environment' } },
  },
  uk: {
    name: 'GitLab',
    summary: 'Репозиторії й задачі GitLab.',
    provides: { repositories: 'Репозиторії', tasks: 'Задачі й merge request-и' },
    platform: {
      label: 'Акаунт GitLab',
      description: 'Увійдіть у GitLab у спливному вікні; підключення для організації зберігає Mastra Platform.',
    },
    direct: {
      label: 'Токен доступу',
      reason: 'Цей сервер підключає GitLab власним GITLAB_ACCESS_TOKEN; його змінюють у середовищі сервера.',
      method: 'Токен сервера',
      state: 'Із середовища сервера',
      changeInEnv: 'Задано в середовищі сервера — змініть змінні середовища',
    },
    method: 'Mastra Platform',
    state: { connected: 'Підключено', reauth: 'Потрібен вхід', reauthMessage: 'GitLab просить увійти знову: «Перепідключити».', refused: 'GitLab не приймає токен' },
    platformOnly: 'Керується в Mastra Platform',
    manage: 'Відкрити Mastra Platform',
    notFound: 'Цього підключення GitLab уже немає.',
    sessionFailed: error => `Mastra Platform не змогла почати вхід у GitLab: ${error}`,
    detail: { host: 'GitLab', mode: 'Підключено через', modes: { platform: 'Mastra Platform', direct: 'середовище сервера' } },
  },
};

const DIRECT_ID = 'direct';

/** GitLab's connections: Platform accounts, or the server's direct token. */
export class GitLabConnections implements IntegrationConnections {
  readonly #gitlab: GitLabConnectionsSource;

  constructor(gitlab: GitLabConnectionsSource) {
    this.#gitlab = gitlab;
  }

  get #host(): string | null {
    const host = this.#gitlab.diagnostics().endpointHost;
    return typeof host === 'string' ? host : null;
  }

  #platformMethod(copy: Copy, request: ConnectionRequest): ConnectMethod {
    return {
      id: 'platform',
      label: copy.platform.label,
      description: copy.platform.description,
      authKind: 'oauth',
      available: true,
    };
  }

  describe(request: ConnectionRequest) {
    const copy = localize(COPY, request.language);
    const platform = this.#gitlab.platformSessions() !== undefined;
    return {
      name: copy.name,
      icon: 'gitlab',
      description: copy.summary,
      category: 'sources' as const,
      provides: [
        { key: 'code', label: copy.provides.repositories },
        { key: 'tasks', label: copy.provides.tasks },
      ],
      capabilities: {
        multipleConnectionsPerToolkit: platform,
        batchConnectionStatus: false,
        reauthorizeReusesConnectionId: true,
        supportsRevoke: false,
      },
      methods: platform
        ? [this.#platformMethod(copy, request)]
        : [{ id: 'token', label: copy.direct.label, authKind: 'apiKey' as const, available: { reason: copy.direct.reason } }],
    };
  }

  async list(request: ConnectionRequest): Promise<ConnectorConnection[]> {
    const copy = localize(COPY, request.language);
    const provides = [
      { key: 'repositories', label: copy.provides.repositories },
      { key: 'tasks', label: copy.provides.tasks },
    ];
    const connections = await this.#gitlab.statusConnections();
    if (connections === undefined) {
      const env = { reason: copy.direct.changeInEnv };
      const refused = await this.#gitlab.verifyStatus().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      return [
        {
          id: DIRECT_ID,
          status: refused ? 'needs_reauth' : 'active',
          displayName: null,
          accountLabel: this.#host,
          label: this.#host ?? copy.name,
          method: copy.direct.method,
          provides,
          state: refused ? { tone: 'error', label: copy.state.refused, message: refused } : { tone: 'ok', label: copy.direct.state },
          scope: 'organization',
          actions: { rename: env, reconnect: env, remove: env },
        },
      ];
    }
    const platform = { reason: copy.platformOnly };
    return connections.map(connection => {
      const reauth = connection.status === 'needs_reauth';
      const displayName = connection.displayName?.trim() || null;
      return {
        id: connection.id,
        status: connection.status,
        displayName,
        accountLabel: connection.accountLabel,
        label: displayName ?? connection.accountLabel ?? copy.name,
        method: copy.method,
        provides,
        state: reauth ? { tone: 'warning', label: copy.state.reauth, message: copy.state.reauthMessage } : { tone: 'ok', label: copy.state.connected },
        scope: 'organization',
        actions: {
          rename: platform,
          reconnect: { method: this.#platformMethod(copy, request) },
          remove: platform,
          manageExternally: { url: MASTRA_PLATFORM_URL, label: copy.manage },
        },
      } satisfies ConnectorConnection;
    });
  }

  async #session(
    request: ConnectionRequest,
    mint: () => Promise<GitLabPlatformSession>,
  ): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    try {
      const session = await mint();
      return connectionOk({
        type: 'authorize',
        authId: session.connectionId,
        session: { provider: 'nango', token: session.sessionToken, integrationId: session.integrationId, expiresAt: session.expiresAt },
      });
    } catch (error) {
      return connectionRefused(502, { error: 'platform_request_failed', message: copy.sessionFailed(error instanceof Error ? error.message : String(error)) });
    }
  }

  async connect(request: ConnectionRequest, methodId: string): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const sessions = this.#gitlab.platformSessions();
    if (!sessions) return connectionRefused(409, { error: 'direct_mode', message: copy.direct.reason });
    if (methodId !== 'platform') return connectionRefused(404, { error: 'unknown_method', message: copy.notFound });
    return this.#session(request, () => sessions.connect());
  }

  async reconnect(request: ConnectionRequest, id: string): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const sessions = this.#gitlab.platformSessions();
    if (!sessions) return connectionRefused(409, { error: 'direct_mode', message: copy.direct.reason });
    const connections = (await this.#gitlab.statusConnections()) ?? [];
    if (!connections.some(connection => connection.id === id)) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    return this.#session(request, () => sessions.reconnect(id));
  }

  /** A Platform sign-in is complete once its connection reports `active` (the vendor confirms asynchronously). */
  async getAuthStatus(_request: ConnectionRequest, authId: string): Promise<AuthFlowStatus | null> {
    if (!this.#gitlab.platformSessions()) return null;
    const connection = ((await this.#gitlab.statusConnections()) ?? []).find(candidate => candidate.id === authId);
    return connection?.status === 'active' ? 'completed' : 'pending';
  }

  async detail(request: ConnectionRequest, id: string): Promise<ConnectionDetailSection[] | null> {
    const copy = localize(COPY, request.language);
    const listed = (await this.list(request)).find(connection => connection.id === id);
    if (!listed) return null;
    const direct = id === DIRECT_ID && this.#gitlab.platformSessions() === undefined;
    return [
      {
        type: 'facts',
        rows: [
          ...(this.#host ? [{ label: copy.detail.host, value: this.#host }] : []),
          { label: copy.detail.mode, value: direct ? copy.detail.modes.direct : copy.detail.modes.platform },
        ],
      },
      ...(listed.state.message
        ? [{ type: 'notice' as const, tone: listed.state.tone === 'error' ? ('error' as const) : ('warning' as const), title: listed.state.label, message: listed.state.message }]
        : []),
    ];
  }
}
