/**
 * GitHub's connections facet (ADR-0034, ADR-0035): every connection of the organization — the
 * GitHub App on an account, or a personal access token — as Settings › Підключення shows it, with
 * the methods to add one, what each connection may do, and what deleting one moves or unlinks.
 * Everything the person reads is written here, in the request's language.
 */

import type { SessionRetirementCoordinator } from '@factory/sandbox';
import type { FactoryProjectsStorage, SourceControlInstallation, WorkItemsStorage } from '@factory/store';
import { connectionOk, connectionRefused, localize } from '@factory/integrations';
import type {
  ConnectionCopy,
  ConnectionDetailSection,
  ConnectionOutcome,
  ConnectionRequest,
  ConnectMethod,
  ConnectorConnection,
  ConnectorConnectResult,
  IntegrationConnections,
  RemovalImpact,
} from '@factory/integrations';

import type { GithubIntegration } from './integration.ts';

/** A GitHub connection as the server reads it (ADR-0034). Never a token. */
export interface GithubConnectionView {
  /** Storage id of the installation row. */
  id: string;
  kind: 'app' | 'token';
  /** Token connections: a token the organization stored, or the server's `GITHUB_ACCESS_TOKEN` fallback. */
  tokenSource?: 'stored' | 'env';
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  needsAttention: boolean;
  /** Why it needs attention. */
  attention?: 'not_found' | 'token_missing' | 'no_app';
  /** The organization's own name for the connection; `null` shows the account. */
  name: string | null;
  createdAt: string;
  /** Who connected it. */
  connectedBy: string;
  /** Project connections still using its repositories. */
  projectConnections: number;
}

/** What deleting a connection would move or unlink (ADR-0034). */
export interface GithubConnectionUsage {
  connection: GithubConnectionView;
  /** Factories (projects) whose repositories come through this connection. */
  factories: Array<{ id: string; name: string }>;
  repositories: Array<{
    /** Storage id of the repository row. */
    id: string;
    slug: string;
    /** GitHub repository id. */
    externalId: string;
    /** Names of the Factories linking it. */
    factories: string[];
    projectRepositoryIds: string[];
    /** Another connection of the organization that reaches it, which it moves to; null: it is unlinked. */
    target: { id: string; kind: 'app' | 'token'; accountLogin: string | null } | null;
  }>;
}

/** How an installation row connects: its stored kind, refined by how its id resolves now. */
export async function describeInstallation(
  github: GithubIntegration,
  row: SourceControlInstallation,
): Promise<GithubConnectionView> {
  const installationId = Number(row.externalId);
  const resolved = await github.tokens.resolve(installationId).catch(() => undefined);
  const storedAsToken = row.providerMetadata.auth === 'token';
  const kind = resolved?.kind === 'token' || storedAsToken ? 'token' : 'app';
  const tokenSource = resolved?.kind === 'token' ? resolved.source : undefined;
  const usage = await github.sourceControlStorage.installations.usage({ orgId: row.orgId, id: row.id });
  // A token row whose token is gone, or an App row with no App on this server, cannot be used.
  const attention =
    typeof row.providerMetadata.attention === 'string'
      ? ('not_found' as const)
      : kind === 'token' && !tokenSource
        ? ('token_missing' as const)
        : kind === 'app' && !github.appConfigured
          ? ('no_app' as const)
          : undefined;
  return {
    id: row.id,
    kind,
    ...(tokenSource ? { tokenSource } : {}),
    installationId,
    accountLogin: row.accountName,
    accountType: row.accountType,
    needsAttention: attention !== undefined,
    ...(attention ? { attention } : {}),
    name: row.displayName,
    createdAt: row.createdAt.toISOString(),
    connectedBy: row.connectedByUserId,
    projectConnections: usage.projectConnections,
  };
}

export function withoutAttention(metadata: Record<string, unknown>): Record<string, unknown> {
  const { attention: _attention, attentionAt: _attentionAt, ...rest } = metadata;
  return rest;
}

const MAX_TOKEN_LENGTH = 500;

/** A pasted token, trimmed, or null when it cannot be one. */
export function parseGithubToken(value: unknown): string | null {
  const token = typeof value === 'string' ? value.trim() : '';
  return token && token.length <= MAX_TOKEN_LENGTH && !/\s/.test(token) ? token : null;
}

interface Copy {
  name: string;
  summary: string;
  capabilities: { repositories: string; tasks: string };
  app: { label: string; description: string; noApp: string };
  token: {
    label: string;
    description: string;
    field: string;
    help: string;
    submit: string;
    replace: string;
    missing: string;
    rejected: (status: number) => string;
    unreachable: (error: string) => string;
    mismatch: (token: string, account: string) => string;
    connectedTitle: (account: string) => string;
    replacedTitle: (account: string) => string;
    reaches: (count: number) => string;
  };
  method: { app: string; token: string; envToken: string };
  accountType: (type: string | null) => string | undefined;
  state: { connected: string; env: string; attention: string };
  attention: { not_found: string; token_missing: string; no_app: string };
  manage: string;
  usedBy: (count: number) => string;
  notFound: string;
  invalidName: string;
  remove: {
    title: (name: string) => string;
    body: string;
    nothing: string;
    factory: (name: string) => string;
    repositories: string;
    moves: (account: string, kind: 'app' | 'token') => string;
    unlinks: string;
    confirm: string;
    confirmMove: string;
    confirmUnlink: string;
    cancel: string;
    inUse: (account: string) => string;
    retirementUnavailable: string;
    done: (moved: number, unlinked: number) => string;
  };
  detail: {
    connection: string;
    method: string;
    account: string;
    repositories: string;
    repositoriesHint: string;
    columns: [string, string];
    visibility: { private: string; public: string };
    noRepositories: string;
    unreadable: string;
  };
}

const KIND_EN = { app: 'GitHub App', token: 'token' } as const;
const KIND_UK = { app: 'GitHub App', token: 'токен' } as const;

const COPY: ConnectionCopy<Copy> = {
  en: {
    name: 'GitHub',
    summary: 'Repositories, issues and pull requests.',
    capabilities: { repositories: 'Repositories', tasks: 'Issues and pull requests' },
    app: {
      label: 'GitHub App',
      description: 'Install the Factory app on a GitHub account or organization and choose its repositories.',
      noApp: 'This server has no GitHub App. Connect with an access token instead.',
    },
    token: {
      label: 'Access token',
      description: 'A personal access token of a GitHub account. Factory checks it with GitHub and stores it encrypted.',
      field: 'Access token',
      help:
        'Classic with the repo scope, or fine-grained with Contents, Issues, Pull requests and Commit statuses read and write. ' +
        'It is sent once and never shown again.',
      submit: 'Connect',
      replace: 'Replace token',
      missing: 'Paste a GitHub access token (ghp_… or github_pat_…).',
      rejected: status =>
        `GitHub rejected this token (${status}). Paste a personal access token: classic with the repo scope, ` +
        'or fine-grained with Contents, Issues, Pull requests and Commit statuses read and write.',
      unreachable: error => `GitHub could not check the token: ${error}`,
      mismatch: (token, account) => `This token belongs to @${token}, not @${account}. Add it as a new connection instead.`,
      connectedTitle: account => `@${account} is connected`,
      replacedTitle: account => `The token of @${account} is replaced`,
      reaches: count => `It reaches ${count} ${count === 1 ? 'repository' : 'repositories'}.`,
    },
    method: { app: 'GitHub App', token: 'Token', envToken: 'Server token' },
    accountType: type => (type === 'Organization' ? 'Organization' : type === 'User' ? 'User' : undefined),
    state: { connected: 'Connected', env: 'From the server environment', attention: 'Needs attention' },
    attention: {
      not_found: 'GitHub no longer finds this App installation. Reinstall the app on the account.',
      token_missing: 'The token of this connection is gone. Paste a new one in «Reconnect».',
      no_app: 'This server has no GitHub App any more. Connect the account with a token.',
    },
    manage: 'Open on GitHub',
    usedBy: count => `Used by ${count} ${count === 1 ? 'Factory' : 'Factories'}`,
    notFound: 'This GitHub connection no longer exists.',
    invalidName: 'A name is up to 80 characters; empty goes back to the account.',
    remove: {
      title: name => `Delete «${name}»?`,
      body: 'The connection is deleted for the whole organization; its token, if it has one, is erased.',
      nothing: 'No Factory uses its repositories.',
      factory: name => `Factory «${name}»`,
      repositories: 'Repositories',
      moves: (account, kind) => `Moves to ${account} · ${KIND_EN[kind]}`,
      unlinks: 'Unlinked: Factory stops seeing it',
      confirm: 'Delete',
      confirmMove: 'Delete and move',
      confirmUnlink: 'Delete and unlink',
      cancel: 'Cancel',
      inUse: account => `Projects still use repositories of @${account}. Confirm to move or unlink them.`,
      retirementUnavailable: 'Sessions of the repositories to unlink cannot be stopped on this server.',
      done: (moved, unlinked) =>
        moved + unlinked === 0 ? 'The connection is deleted.' : `The connection is deleted. Moved: ${moved}, unlinked: ${unlinked}.`,
    },
    detail: {
      connection: 'Connection',
      method: 'How it connects',
      account: 'Account',
      repositories: 'Repositories',
      repositoriesHint: 'What this connection reaches on GitHub. Which of them a Factory works in is set in Repositories.',
      columns: ['Repository', 'Visibility'],
      visibility: { private: 'Private', public: 'Public' },
      noRepositories: 'This connection reaches no repositories.',
      unreadable: 'GitHub could not list the repositories',
    },
  },
  uk: {
    name: 'GitHub',
    summary: 'Репозиторії, задачі й пул-реквести.',
    capabilities: { repositories: 'Репозиторії', tasks: 'Задачі й пул-реквести' },
    app: {
      label: 'GitHub App',
      description: 'Встановіть застосунок Factory на акаунт чи організацію GitHub і виберіть репозиторії.',
      noApp: 'На цьому сервері немає GitHub App. Підключіть токеном доступу.',
    },
    token: {
      label: 'Токен доступу',
      description: 'Персональний токен акаунта GitHub. Factory перевіряє його в GitHub і зберігає зашифрованим.',
      field: 'Токен доступу',
      help:
        'Classic зі scope repo або fine-grained з Contents, Issues, Pull requests і Commit statuses на читання й запис. ' +
        'Надсилається один раз і більше не показується.',
      submit: 'Підключити',
      replace: 'Замінити токен',
      missing: 'Вставте токен доступу GitHub (ghp_… або github_pat_…).',
      rejected: status =>
        `GitHub не прийняв цей токен (${status}). Потрібен персональний токен: classic зі scope repo ` +
        'або fine-grained з Contents, Issues, Pull requests і Commit statuses на читання й запис.',
      unreachable: error => `GitHub не зміг перевірити токен: ${error}`,
      mismatch: (token, account) => `Цей токен належить @${token}, а не @${account}. Додайте його як нове підключення.`,
      connectedTitle: account => `@${account} підключено`,
      replacedTitle: account => `Токен @${account} замінено`,
      reaches: count => `Доступно репозиторіїв: ${count}.`,
    },
    method: { app: 'GitHub App', token: 'Токен', envToken: 'Токен сервера' },
    accountType: type => (type === 'Organization' ? 'Організація' : type === 'User' ? 'Користувач' : undefined),
    state: { connected: 'Підключено', env: 'Із середовища сервера', attention: 'Потребує уваги' },
    attention: {
      not_found: 'GitHub більше не знаходить це встановлення App. Перевстановіть застосунок на акаунті.',
      token_missing: 'Токена цього підключення немає. Вставте новий у «Перепідключити».',
      no_app: 'На цьому сервері більше немає GitHub App. Підключіть акаунт токеном.',
    },
    manage: 'Відкрити на GitHub',
    usedBy: count => `Використовують Factory: ${count}`,
    notFound: 'Цього підключення GitHub уже немає.',
    invalidName: 'Назва — до 80 символів; порожня повертає назву акаунта.',
    remove: {
      title: name => `Видалити «${name}»?`,
      body: 'Підключення видаляється для всієї організації; його токен, якщо є, стирається.',
      nothing: 'Жодна Factory не використовує його репозиторії.',
      factory: name => `Factory «${name}»`,
      repositories: 'Репозиторії',
      moves: (account, kind) => `Перейде до ${account} · ${KIND_UK[kind]}`,
      unlinks: 'Відв’яжеться: Factory перестане його бачити',
      confirm: 'Видалити',
      confirmMove: 'Видалити й перенести',
      confirmUnlink: 'Видалити й відв’язати',
      cancel: 'Скасувати',
      inUse: account => `Проєкти ще використовують репозиторії @${account}. Підтвердьте, щоб перенести або відв’язати їх.`,
      retirementUnavailable: 'На цьому сервері не можна зупинити сесії репозиторіїв, що відв’язуються.',
      done: (moved, unlinked) =>
        moved + unlinked === 0 ? 'Підключення видалено.' : `Підключення видалено. Перенесено: ${moved}, відв’язано: ${unlinked}.`,
    },
    detail: {
      connection: 'Підключення',
      method: 'Як підключено',
      account: 'Акаунт',
      repositories: 'Репозиторії',
      repositoriesHint: 'Що це підключення бачить у GitHub. У яких із них працює Factory — у розділі «Репозиторії».',
      columns: ['Репозиторій', 'Видимість'],
      visibility: { private: 'Приватний', public: 'Публічний' },
      noRepositories: 'Це підключення не бачить жодного репозиторію.',
      unreadable: 'GitHub не віддав список репозиторіїв',
    },
  },
};

export interface GithubConnectionsDeps {
  github: GithubIntegration;
  projects?: Pick<FactoryProjectsStorage, 'get'>;
  sessionRetirement?: SessionRetirementCoordinator;
  workItems?: Pick<WorkItemsStorage, 'clearSessionReferences'>;
}

type TokenCheck =
  | { ok: true; account: { id: number; login: string; type: string }; repositoryCount: number }
  | { ok: false; status: 422 | 502; error: string; message: string };

/**
 * GitHub's connections: one per installation row of the organization (the App on an account, or an
 * access token), connected through the App's install flow or a pasted token.
 */
export class GithubConnections implements IntegrationConnections {
  readonly #deps: GithubConnectionsDeps;

  constructor(deps: GithubConnectionsDeps) {
    this.#deps = deps;
  }

  get #github() {
    return this.#deps.github;
  }

  #appMethod(copy: Copy): ConnectMethod {
    return {
      id: 'app',
      label: copy.app.label,
      description: copy.app.description,
      authKind: 'oauth',
      available: this.#github.appConfigured ? true : { reason: copy.app.noApp },
    };
  }

  #tokenMethod(copy: Copy, request: ConnectionRequest, replace = false): ConnectMethod {
    return {
      id: 'token',
      label: copy.token.label,
      description: copy.token.description,
      authKind: 'apiKey',
      fields: [
        {
          name: 'token',
          displayName: copy.token.field,
          type: 'secret',
          placeholder: 'ghp_… / github_pat_…',
          description: copy.token.help,
          required: true,
        },
      ],
      submitLabel: replace ? copy.token.replace : copy.token.submit,
      available: true,
    };
  }

  describe(request: ConnectionRequest) {
    const copy = localize(COPY, request.language);
    return {
      name: copy.name,
      icon: 'github',
      description: copy.summary,
      category: 'sources' as const,
      provides: [
        { key: 'code', label: copy.capabilities.repositories },
        { key: 'tasks', label: copy.capabilities.tasks },
      ],
      // Several accounts side by side; reconnecting keeps the connection; deleting is Factory's, not a revoke at GitHub.
      capabilities: {
        multipleConnectionsPerToolkit: true,
        batchConnectionStatus: false,
        reauthorizeReusesConnectionId: true,
        supportsRevoke: false,
      },
      health: this.#github.appConfigured ? { ok: true } : { ok: true, message: copy.app.noApp },
      methods: [this.#appMethod(copy), this.#tokenMethod(copy, request)],
    };
  }

  #view(request: ConnectionRequest, view: GithubConnectionView): ConnectorConnection {
    const copy = localize(COPY, request.language);
    const fromEnv = view.kind === 'token' && view.tokenSource === 'env';
    const accountDetail = copy.accountType(view.accountType);
    const manageUrl =
      view.kind === 'app' && view.accountLogin
        ? view.accountType === 'Organization'
          ? `https://github.com/organizations/${view.accountLogin}/settings/installations/${view.installationId}`
          : `https://github.com/settings/installations/${view.installationId}`
        : undefined;
    return {
      id: view.id,
      status: view.needsAttention ? 'needs_reauth' : 'active',
      displayName: view.name,
      accountLabel: view.accountLogin,
      ...(accountDetail ? { accountDetail } : {}),
      label: view.name ?? view.accountLogin ?? copy.name,
      method: view.kind === 'app' ? copy.method.app : fromEnv ? copy.method.envToken : copy.method.token,
      provides: [
        { key: 'repositories', label: copy.capabilities.repositories },
        { key: 'tasks', label: copy.capabilities.tasks },
      ],
      state: view.attention
        ? { tone: 'warning', label: copy.state.attention, message: copy.attention[view.attention] }
        : fromEnv
          ? { tone: 'ok', label: copy.state.env }
          : { tone: 'ok', label: copy.state.connected },
      scope: 'organization',
      createdAt: view.createdAt,
      createdBy: view.connectedBy,
      ...(view.projectConnections > 0 ? { dependents: copy.usedBy(view.projectConnections) } : {}),
      actions: {
        rename: true,
        // The App is re-authorized through its install flow; a token is replaced in its form.
        reconnect: { method: view.kind === 'app' ? this.#appMethod(copy) : this.#tokenMethod(copy, request, true) },
        remove: true,
        ...(manageUrl ? { manageExternally: { url: manageUrl, label: copy.manage } } : {}),
      },
    };
  }

  async #row(request: ConnectionRequest, id: string): Promise<SourceControlInstallation | null> {
    return this.#github.sourceControlStorage.installations.get({ orgId: request.orgId, id });
  }

  async list(request: ConnectionRequest): Promise<ConnectorConnection[]> {
    const rows = await this.#github.sourceControlStorage.installations.list({ orgId: request.orgId });
    const views = await Promise.all(rows.map(row => describeInstallation(this.#github, row)));
    return views.map(view => this.#view(request, view));
  }

  /** The account and reachable repositories of a pasted token, or why it is refused. */
  async #checkToken(copy: Copy, token: string): Promise<TokenCheck> {
    try {
      const account = await this.#github.tokens.checkToken(token);
      const repositories = await this.#github.tokens.forToken(token).listRepos(account.id);
      return { ok: true, account, repositoryCount: repositories.length };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403) {
        return { ok: false, status: 422, error: 'invalid_token', message: copy.token.rejected(status) };
      }
      return {
        ok: false,
        status: 502,
        error: 'github_unreachable',
        message: copy.token.unreachable(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  /** Stores the token for the account's installation row and marks the row a token connection. */
  async #saveToken(args: {
    orgId: string;
    userId: string;
    token: string;
    account: { id: number; login: string; type: string };
    repositoryCount: number;
    existing: SourceControlInstallation | null;
  }): Promise<SourceControlInstallation> {
    await this.#github.tokens.save(args.orgId, args.account.id, args.token, args.account.login);
    return this.#github.sourceControlStorage.installations.upsert({
      orgId: args.orgId,
      connectedByUserId: args.existing?.connectedByUserId ?? args.userId,
      externalId: String(args.account.id),
      accountName: args.account.login,
      accountType: args.account.type,
      providerMetadata: {
        ...withoutAttention(args.existing?.providerMetadata ?? {}),
        auth: 'token',
        repositoryCount: args.repositoryCount,
      },
    });
  }

  /** Connects (or, with `existing`, replaces) a token; the token is never returned. */
  async #connectToken(
    request: ConnectionRequest,
    input: Record<string, string>,
    existing: SourceControlInstallation | null,
  ): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const token = parseGithubToken(input.token);
    if (!token) {
      return connectionRefused(422, { error: 'invalid_body', message: copy.token.missing, fields: { token: copy.token.missing } });
    }
    const checked = await this.#checkToken(copy, token);
    if (!checked.ok) {
      return connectionRefused(checked.status, {
        error: checked.error,
        message: checked.message,
        ...(checked.status === 422 ? { fields: { token: checked.message } } : {}),
      });
    }
    // Reconnecting keeps the connection the account: its repositories and projects stay with it.
    if (existing && String(checked.account.id) !== existing.externalId) {
      const message = copy.token.mismatch(checked.account.login, existing.accountName ?? existing.externalId);
      return connectionRefused(422, { error: 'account_mismatch', message, fields: { token: message } });
    }
    const current =
      existing ??
      (await this.#github.sourceControlStorage.installations.findByExternalId({
        orgId: request.orgId,
        externalId: String(checked.account.id),
      }));
    const row = await this.#saveToken({ orgId: request.orgId, userId: request.userId, token, ...checked, existing: current });
    request.audit('token_connected', { replaced: current !== null, account: checked.account.login });
    return connectionOk({
      type: 'connected',
      connection: this.#view(request, await describeInstallation(this.#github, row)),
      title: current ? copy.token.replacedTitle(checked.account.login) : copy.token.connectedTitle(checked.account.login),
      message: copy.token.reaches(checked.repositoryCount),
    });
  }

  async connect(
    request: ConnectionRequest,
    methodId: string,
    input: Record<string, string>,
  ): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    if (methodId === 'app') {
      if (!this.#github.appConfigured) return connectionRefused(409, { error: 'no_app', message: copy.app.noApp });
      // The App's identify-then-install flow signs its state for this session itself.
      return connectionOk({ type: 'authorize', url: '/auth/github/connect' });
    }
    if (methodId === 'token') return this.#connectToken(request, input, null);
    return connectionRefused(404, { error: 'unknown_method', message: copy.notFound });
  }

  async reconnect(
    request: ConnectionRequest,
    id: string,
    input: Record<string, string>,
  ): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const row = await this.#row(request, id);
    if (!row) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const view = await describeInstallation(this.#github, row);
    if (view.kind === 'app') {
      if (!this.#github.appConfigured) return connectionRefused(409, { error: 'no_app', message: copy.app.noApp });
      return connectionOk({ type: 'authorize', url: '/auth/github/connect?manage=1' });
    }
    return this.#connectToken(request, input, row);
  }

  async rename(request: ConnectionRequest, id: string, name: string): Promise<ConnectionOutcome<{ name: string }>> {
    const copy = localize(COPY, request.language);
    if (name.length > 80) return connectionRefused(422, { error: 'invalid_body', message: copy.invalidName, fields: { name: copy.invalidName } });
    const renamed = await this.#github.sourceControlStorage.installations.rename({ orgId: request.orgId, id, name: name || null });
    if (!renamed) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    return connectionOk({ name: renamed.displayName ?? renamed.accountName ?? copy.name });
  }

  /**
   * What depends on a connection: the Factories (projects) linking its repositories, and for each
   * repository whether another GitHub connection of the organization reaches it (by GitHub repository
   * id, from each connection's live repository list), so deleting it can move instead of unlink.
   */
  async usage(row: SourceControlInstallation, orgId: string): Promise<GithubConnectionUsage> {
    const github = this.#github;
    const handle = github.sourceControlStorage;
    const view = await describeInstallation(github, row);
    const factories = new Map<string, string>();
    const repositories: GithubConnectionUsage['repositories'] = [];
    for (const repository of await handle.repositories.list({ orgId, installationId: row.id })) {
      const targets = (
        await handle.projectRepositories.listByExternalRepository({
          installationExternalId: row.externalId,
          repositoryExternalId: repository.externalId,
        })
      ).filter(target => target.orgId === orgId && target.projectRepository.repositoryId === repository.id);
      if (targets.length === 0) continue;
      const names: string[] = [];
      for (const target of targets) {
        if (!factories.has(target.factoryProjectId)) {
          const project = await this.#deps.projects?.get({ orgId, id: target.factoryProjectId }).catch(() => null);
          factories.set(target.factoryProjectId, project?.name ?? target.factoryProjectId);
        }
        names.push(factories.get(target.factoryProjectId)!);
      }
      repositories.push({
        id: repository.id,
        slug: repository.slug,
        externalId: repository.externalId,
        factories: [...new Set(names)],
        projectRepositoryIds: targets.map(target => target.projectRepository.id),
        target: null,
      });
    }
    if (repositories.length > 0) {
      const others = (await handle.installations.list({ orgId })).filter(other => other.id !== row.id);
      const reach = await Promise.all(
        others.map(async other => {
          const otherView = await describeInstallation(github, other);
          const ids = await github
            .listInstallationRepos(otherView.installationId)
            .then(list => new Set(list.map(repo => String(repo.id))))
            .catch(() => new Set<string>());
          return { view: otherView, ids };
        }),
      );
      for (const repository of repositories) {
        const found = reach.find(other => !other.view.needsAttention && other.ids.has(repository.externalId));
        if (found) repository.target = { id: found.view.id, kind: found.view.kind, accountLogin: found.view.accountLogin };
      }
    }
    return { connection: view, factories: [...factories].map(([id, name]) => ({ id, name })), repositories };
  }

  #impact(request: ConnectionRequest, row: SourceControlInstallation, usage: GithubConnectionUsage): RemovalImpact {
    const copy = localize(COPY, request.language);
    const name = row.displayName ?? row.accountName ?? row.externalId;
    const unlinks = usage.repositories.some(repository => !repository.target);
    return {
      title: copy.remove.title(name),
      body: usage.repositories.length ? copy.remove.body : `${copy.remove.body} ${copy.remove.nothing}`,
      dependents: usage.factories.map(factory => ({ label: copy.remove.factory(factory.name) })),
      ...(usage.repositories.length ? { itemsLabel: copy.remove.repositories } : {}),
      items: usage.repositories.map(repository => ({
        label: repository.slug,
        outcome: repository.target ? ('moves' as const) : ('unlinks' as const),
        outcomeLabel: repository.target
          ? copy.remove.moves(repository.target.accountLogin ? `@${repository.target.accountLogin}` : '—', repository.target.kind)
          : copy.remove.unlinks,
      })),
      confirmLabel: !usage.repositories.length ? copy.remove.confirm : unlinks ? copy.remove.confirmUnlink : copy.remove.confirmMove,
      cancelLabel: copy.remove.cancel,
      requiresConfirm: usage.factories.length > 0,
    };
  }

  async removalImpact(request: ConnectionRequest, id: string): Promise<RemovalImpact | null> {
    const row = await this.#row(request, id);
    return row ? this.#impact(request, row, await this.usage(row, request.orgId)) : null;
  }

  /**
   * Deletes a connection. One projects still use is refused without `confirm` (with what would move
   * or be unlinked); with it, reachable repositories move to another connection and the rest are
   * unlinked, in one transaction, after the sessions of links that go away are retired.
   */
  async remove(request: ConnectionRequest, id: string, options: { confirm: boolean }): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    const github = this.#github;
    const { orgId } = request;
    const existing = await this.#row(request, id);
    if (!existing) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const usage = await this.usage(existing, orgId);
    if (usage.factories.length > 0 && !options.confirm) {
      return connectionRefused(409, {
        error: 'connection_in_use',
        message: copy.remove.inUse(existing.accountName ?? existing.externalId),
        impact: this.#impact(request, existing, usage),
      });
    }
    const unlinkedLinks = usage.repositories.filter(repository => !repository.target).flatMap(repository => repository.projectRepositoryIds);
    for (const projectRepositoryId of unlinkedLinks) {
      const sessions = await github.sourceControlStorage.sessions.listByProjectRepository({ projectRepositoryId });
      if (sessions.length === 0) continue;
      const retirement = this.#deps.sessionRetirement;
      if (!retirement) return connectionRefused(409, { error: 'session_retirement_unavailable', message: copy.remove.retirementUnavailable });
      await retirement.retireProjectRepositorySessions({
        sourceControl: github.sourceControlStorage,
        ...(this.#deps.workItems ? { workItems: this.#deps.workItems } : {}),
        orgId,
        projectRepositoryId,
      });
    }
    const moves: Record<string, string> = {};
    for (const repository of usage.repositories) {
      if (repository.target) moves[repository.id] = repository.target.id;
    }
    const summary = await github.sourceControlStorage.installations.removeMovingRepositories({ orgId, id: existing.id, moves });
    await github.tokens.remove(orgId, Number(existing.externalId));
    const targetsById = new Map(usage.repositories.flatMap(repository => (repository.target ? [[repository.id, repository.target]] : [])));
    request.audit('connection_removed', {
      account: existing.accountName,
      kind: usage.connection.kind,
      factories: usage.factories.map(factory => factory.name),
      moved: summary.moved.map(entry => ({ slug: entry.slug, to: targetsById.get(entry.repositoryId)?.accountLogin ?? null })),
      unlinked: summary.unlinked.map(entry => entry.slug),
    });
    return connectionOk({ message: copy.remove.done(summary.moved.length, summary.unlinked.length) });
  }

  /** The connection's facts and the repositories it reaches on GitHub, read live. */
  async detail(request: ConnectionRequest, id: string): Promise<ConnectionDetailSection[] | null> {
    const copy = localize(COPY, request.language);
    const row = await this.#row(request, id);
    if (!row) return null;
    const view = await describeInstallation(this.#github, row);
    const sections: ConnectionDetailSection[] = [];
    if (view.attention) {
      sections.push({ type: 'notice', tone: 'warning', title: copy.state.attention, message: copy.attention[view.attention] });
    }
    try {
      const repositories = await this.#github.listInstallationRepos(view.installationId);
      sections.push({
        type: 'table',
        title: copy.detail.repositories,
        description: copy.detail.repositoriesHint,
        columns: [...copy.detail.columns],
        rows: repositories.map(repo => ({
          cells: [repo.fullName, repo.private ? copy.detail.visibility.private : copy.detail.visibility.public],
          href: `https://github.com/${repo.fullName}`,
        })),
        empty: copy.detail.noRepositories,
      });
    } catch (error) {
      sections.push({
        type: 'notice',
        tone: 'error',
        title: copy.detail.unreadable,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return sections;
  }
}
