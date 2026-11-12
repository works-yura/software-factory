/**
 * ClickUp's connections facet (ADR-0032, ADR-0035): the organization's one ClickUp token as
 * Settings › Підключення shows it — connected with a pasted token, checked live, renamed, replaced
 * and removed (after saying which Factories stop reading ClickUp Lists) — and the import switch as
 * its setting. Everything the person reads is written here, in the request's language.
 */

import { routedSourceScopes } from '@factory/core';
import type { IntakeRoutesReader } from '@factory/core';
import { connectionOk, connectionRefused, localize } from '@factory/integrations';
import type {
  ConnectionCopy,
  ConnectionDetailSection,
  ConnectionOutcome,
  ConnectionRequest,
  ConnectionSettingsValues,
  ConnectMethod,
  ConnectorConnection,
  ConnectorConnectResult,
  IntegrationConnections,
  RemovalImpact,
} from '@factory/integrations';
import type { FactoryProjectsStorage, IntakeStorage } from '@factory/store';

import { ClickUpApiError } from './api.ts';
import { clickUpMetadataOf, clickUpTokenOf, saveClickUpConnection } from './connection.ts';
import type { ClickUpClients, ClickUpConnectionMetadata, ClickUpConnectionStorage } from './connection.ts';

/** The connector's own id of the organization's one connection (`clickup:org`). */
export const CLICKUP_CONNECTION_ID = 'org';
const MAX_TOKEN_LENGTH = 500;

const ukLists = (count: number) =>
  count % 10 === 1 && count % 100 !== 11 ? 'список' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'списки' : 'списків';

interface Copy {
  name: string;
  summary: string;
  tasks: string;
  method: { label: string; description: string; field: string; help: string; submit: string; replace: string; missing: string };
  already: string;
  adminOnly: string;
  rejected: (status: number) => string;
  unreachable: (error: string) => string;
  connectedTitle: (account: string) => string;
  replacedTitle: (account: string) => string;
  workspaces: (names: string[]) => string;
  state: { connected: string; refused: string };
  notFound: string;
  invalidName: string;
  usedBy: (count: number) => string;
  remove: {
    title: (name: string) => string;
    body: string;
    nothing: string;
    factory: (name: string) => string;
    stops: (lists: number) => string;
    itemsLabel: string;
    confirm: string;
    cancel: string;
    inUse: string;
    done: string;
  };
  detail: { title: string; workspaces: string; account: string; interval: (seconds: number) => string; pace: string };
  settings: { title: string; description: string; sync: string; syncHelp: string; notConnected: string; saved: (on: boolean) => string };
  routesUnavailable: string;
}

const COPY: ConnectionCopy<Copy> = {
  en: {
    name: 'ClickUp',
    summary: 'Tasks from ClickUp Lists land on boards by the intake routes.',
    tasks: 'Tasks',
    method: {
      label: 'API token',
      description: 'A ClickUp personal API token (pk_…, ClickUp › Settings › Apps). ClickUp checks it; Factory stores it encrypted for your organization only.',
      field: 'ClickUp API token',
      help: 'A regenerated token replaces the old one. It is sent once and never shown again.',
      submit: 'Connect',
      replace: 'Replace token',
      missing: 'Paste a ClickUp API token (pk_…).',
    },
    already: 'ClickUp is already connected. Replace its token with «Reconnect».',
    adminOnly: 'Only organization admins change connections.',
    rejected: status =>
      `ClickUp rejected this token (${status}). Paste a personal API token (pk_…) from ClickUp › Settings › Apps; a regenerated token replaces the old one.`,
    unreachable: error => `ClickUp could not check the token: ${error}`,
    connectedTitle: account => `ClickUp is connected as ${account}`,
    replacedTitle: account => `The token is replaced (${account})`,
    workspaces: names => (names.length ? `Workspaces: ${names.join(', ')}.` : 'The token sees no Workspace.'),
    state: { connected: 'Connected', refused: 'ClickUp refuses the token' },
    notFound: 'ClickUp is not connected for this organization.',
    invalidName: 'A name is up to 80 characters.',
    usedBy: count => `Read by ${count} ${count === 1 ? 'Factory' : 'Factories'}`,
    remove: {
      title: name => `Delete the “${name}” connection?`,
      body: 'The token goes for the whole organization. Intake routes and cards stay.',
      nothing: 'No Factory of the organization reads ClickUp Lists now.',
      factory: name => `Factory «${name}»`,
      stops: lists => `stops reading ${lists} ClickUp ${lists === 1 ? 'List' : 'Lists'} of its intake routes`,
      itemsLabel: 'This stops:',
      confirm: 'Delete',
      cancel: 'Cancel',
      inUse: 'Factories still read ClickUp Lists through this token. Confirm to delete it anyway.',
      done: 'Connection deleted',
    },
    detail: {
      title: 'ClickUp',
      workspaces: 'Workspaces',
      account: 'ClickUp account',
      interval: seconds => `every ${seconds} s`,
      pace: 'Checked',
    },
    settings: {
      title: 'Import',
      description: 'Which Lists a Factory reads, where a task lands and what a status change does are its intake routes (source ClickUp, the «List» condition).',
      sync: 'Import ClickUp tasks',
      syncHelp: 'Off: no ClickUp task is imported in any Factory of the organization.',
      notConnected: 'ClickUp does not accept the token now.',
      saved: on => (on ? 'ClickUp tasks are imported' : 'ClickUp tasks are not imported'),
    },
    routesUnavailable: 'Intake routes are not available on this server, so what stops cannot be counted.',
  },
  uk: {
    name: 'ClickUp',
    summary: 'Задачі зі списків ClickUp потрапляють на дошки за маршрутами надходження.',
    tasks: 'Задачі',
    method: {
      label: 'API-токен',
      description: 'Персональний API-токен ClickUp (pk_…, ClickUp › Settings › Apps). Його перевірить ClickUp, а Factory збереже зашифрованим лише для вашої організації.',
      field: 'API-токен ClickUp',
      help: 'Перегенерований токен замінює старий. Надсилається один раз і більше не показується.',
      submit: 'Підключити',
      replace: 'Замінити токен',
      missing: 'Вставте API-токен ClickUp (pk_…).',
    },
    already: 'ClickUp уже підключено. Замініть токен через «Перепідключити».',
    adminOnly: 'Змінює адміністратор організації.',
    rejected: status =>
      `ClickUp не прийняв цей токен (${status}). Вставте персональний API-токен (pk_…) з ClickUp › Settings › Apps; перегенерований токен замінює старий.`,
    unreachable: error => `ClickUp не зміг перевірити токен: ${error}`,
    connectedTitle: account => `ClickUp підключено як ${account}`,
    replacedTitle: account => `Токен замінено (${account})`,
    workspaces: names => (names.length ? `Робочі простори: ${names.join(', ')}.` : 'Токен не бачить жодного робочого простору.'),
    state: { connected: 'Підключено', refused: 'ClickUp не приймає токен' },
    notFound: 'ClickUp для організації не підключено.',
    invalidName: 'Назва — до 80 символів.',
    usedBy: count => `Читають Factory: ${count}`,
    remove: {
      title: name => `Видалити підключення «${name}»?`,
      body: 'Токен зникне для всієї організації. Маршрути надходження й картки лишаються.',
      nothing: 'Жодна Factory організації зараз не читає списків ClickUp.',
      factory: name => `Factory «${name}»`,
      stops: lists => `перестане читати ${lists} ${ukLists(lists)} ClickUp зі своїх маршрутів надходження`,
      itemsLabel: 'Перестануть діяти:',
      confirm: 'Видалити',
      cancel: 'Скасувати',
      inUse: 'Factory ще читають списки ClickUp через цей токен. Підтвердьте, щоб усе одно видалити.',
      done: 'Підключення видалено',
    },
    detail: {
      title: 'ClickUp',
      workspaces: 'Робочі простори',
      account: 'Акаунт ClickUp',
      interval: seconds => `кожні ${seconds} с`,
      pace: 'Перевіряється',
    },
    settings: {
      title: 'Імпорт',
      description: 'Які списки читає Factory, куди йде задача і що робить зміна статусу — це її маршрути надходження (джерело ClickUp, умова «List»).',
      sync: 'Імпортувати задачі ClickUp',
      syncHelp: 'Вимкнено: жодна Factory організації не імпортує задач ClickUp.',
      notConnected: 'ClickUp зараз не приймає токен.',
      saved: on => (on ? 'Задачі ClickUp імпортуються' : 'Задачі ClickUp не імпортуються'),
    },
    routesUnavailable: 'Маршрути надходження на цьому сервері недоступні, тож не порахувати, що перестане діяти.',
  },
};

export interface ClickUpConnectionsDeps {
  clients: ClickUpClients;
  storage: () => ClickUpConnectionStorage;
  intervalSeconds: number;
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  intakeRoutes: () => IntakeRoutesReader | undefined;
  intake: Pick<IntakeStorage, 'getConfig' | 'saveConfig' | 'ensureReady'>;
}

interface ReadConnection {
  connection: NonNullable<Awaited<ReturnType<ClickUpConnectionStorage['connections']['get']>>>;
  workspaces: string[];
  error: string | undefined;
}

type TokenCheck = { ok: true; account: ClickUpConnectionMetadata } | { ok: false; status: 422 | 502; error: string; message: string };

/** The organization's ClickUp token, one connection per organization. */
export class ClickUpConnections implements IntegrationConnections {
  readonly #deps: ClickUpConnectionsDeps;

  constructor(deps: ClickUpConnectionsDeps) {
    this.#deps = deps;
  }

  #tokenMethod(copy: Copy, request: ConnectionRequest, options: { replace?: boolean; connected?: boolean } = {}): ConnectMethod {
    return {
      id: 'token',
      label: copy.method.label,
      description: copy.method.description,
      authKind: 'apiKey',
      fields: [
        { name: 'token', displayName: copy.method.field, type: 'secret', placeholder: 'pk_…', description: copy.method.help, required: true },
      ],
      submitLabel: options.replace ? copy.method.replace : copy.method.submit,
      available: !request.admin ? { reason: copy.adminOnly } : options.connected ? { reason: copy.already } : true,
    };
  }

  async describe(request: ConnectionRequest) {
    const copy = localize(COPY, request.language);
    const connected = clickUpTokenOf((await this.#deps.storage().connections.get(request.orgId))?.data) !== null;
    return {
      name: copy.name,
      icon: 'clickup',
      description: copy.summary,
      category: 'sources' as const,
      provides: [{ key: 'tasks', label: copy.tasks }],
      // One token per organization; replacing keeps the connection; deleting erases it here, it is not revoked at ClickUp.
      capabilities: {
        multipleConnectionsPerToolkit: false,
        batchConnectionStatus: false,
        reauthorizeReusesConnectionId: true,
        supportsRevoke: false,
      },
      methods: [this.#tokenMethod(copy, request, { connected })],
    };
  }

  /** The stored connection checked live, or null when the organization has none. */
  async #read(request: ConnectionRequest): Promise<ReadConnection | null> {
    const connection = await this.#deps.storage().connections.get(request.orgId);
    const token = clickUpTokenOf(connection?.data);
    if (!connection || !token) return null;
    try {
      const workspaces = (await this.#deps.clients.forToken(token).listWorkspaces()).map(workspace => workspace.name);
      return { connection, workspaces, error: undefined };
    } catch (error) {
      return { connection, workspaces: [] as string[], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Factories of the organization whose intake routes read ClickUp Lists, with how many; null when routes are unavailable. */
  async #usage(orgId: string): Promise<Array<{ name: string; lists: number }> | null> {
    const reader = this.#deps.intakeRoutes();
    if (!reader) return null;
    const factories: Array<{ name: string; lists: number }> = [];
    for (const project of await this.#deps.projects.listAll()) {
      if (project.orgId !== orgId) continue;
      const routes = await reader.listIntakeRoutes({ orgId, factoryProjectId: project.id });
      const lists = routedSourceScopes(routes, 'source.list').length;
      if (lists > 0) factories.push({ name: project.name, lists });
    }
    return factories;
  }

  async #view(request: ConnectionRequest, read: ReadConnection): Promise<ConnectorConnection> {
    const copy = localize(COPY, request.language);
    const meta = read.connection.metadata;
    const stored = clickUpMetadataOf(meta);
    const name = typeof meta.name === 'string' ? meta.name : null;
    const workspaces = read.workspaces.length ? read.workspaces : (stored?.workspaces ?? []);
    const blocked = { reason: copy.adminOnly };
    const usage = await this.#usage(request.orgId).catch(() => null);
    return {
      id: CLICKUP_CONNECTION_ID,
      status: read.error ? 'needs_reauth' : 'active',
      displayName: name,
      accountLabel: stored?.username ?? null,
      ...(workspaces.length ? { accountDetail: workspaces.join(', ') } : {}),
      label: name ?? stored?.username ?? copy.name,
      provides: [{ key: 'tasks', label: copy.tasks }],
      state: read.error ? { tone: 'error', label: copy.state.refused, message: read.error } : { tone: 'ok', label: copy.state.connected },
      scope: 'organization',
      createdAt: read.connection.createdAt.toISOString(),
      ...(typeof meta.connectedBy === 'string' ? { createdBy: meta.connectedBy } : {}),
      ...(usage && usage.length ? { dependents: copy.usedBy(usage.length) } : {}),
      actions: {
        rename: request.admin ? true : blocked,
        reconnect: request.admin ? { method: this.#tokenMethod(copy, request, { replace: true }) } : blocked,
        remove: request.admin ? true : blocked,
      },
    };
  }

  async list(request: ConnectionRequest): Promise<ConnectorConnection[]> {
    const read = await this.#read(request);
    return read ? [await this.#view(request, read)] : [];
  }

  async #check(copy: Copy, token: string): Promise<TokenCheck> {
    const { clients } = this.#deps;
    const client = clients.forToken(token);
    try {
      const user = await client.authorizedUser();
      const workspaces = await client.listWorkspaces();
      return { ok: true, account: { username: user.username, userId: user.id, workspaces: workspaces.map(w => w.name) } };
    } catch (error) {
      clients.forget(token);
      if (error instanceof ClickUpApiError && (error.status === 401 || error.status === 403)) {
        return { ok: false, status: 422, error: 'invalid_token', message: copy.rejected(error.status) };
      }
      return { ok: false, status: 502, error: 'clickup_unreachable', message: copy.unreachable(error instanceof Error ? error.message : String(error)) };
    }
  }

  async #saveToken(request: ConnectionRequest, input: Record<string, string>, replace: boolean): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const token = (input.token ?? '').trim();
    if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
      return connectionRefused(422, { error: 'invalid_body', message: copy.method.missing, fields: { token: copy.method.missing } });
    }
    const storage = this.#deps.storage();
    const previous = await storage.connections.get(request.orgId);
    if (replace && !previous) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const checked = await this.#check(copy, token);
    if (!checked.ok) {
      return connectionRefused(checked.status, {
        error: checked.error,
        message: checked.message,
        ...(checked.status === 422 ? { fields: { token: checked.message } } : {}),
      });
    }
    await saveClickUpConnection(storage, request.orgId, { token, userId: request.userId || null, account: checked.account });
    const before = clickUpTokenOf(previous?.data);
    if (before && before !== token) this.#deps.clients.forget(before);
    request.audit('token_connected', { replaced: previous !== null, account: checked.account.username });
    const read = await this.#read(request);
    return connectionOk({
      type: 'connected',
      connection: await this.#view(request, read!),
      title: previous ? copy.replacedTitle(checked.account.username) : copy.connectedTitle(checked.account.username),
      message: copy.workspaces(checked.account.workspaces),
    });
  }

  async connect(request: ConnectionRequest, methodId: string, input: Record<string, string>): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    if (methodId !== 'token') return connectionRefused(404, { error: 'unknown_method', message: copy.notFound });
    return this.#saveToken(request, input, false);
  }

  async reconnect(request: ConnectionRequest, id: string, input: Record<string, string>): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    if (id !== CLICKUP_CONNECTION_ID) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    return this.#saveToken(request, input, true);
  }

  async rename(request: ConnectionRequest, id: string, name: string): Promise<ConnectionOutcome<{ name: string }>> {
    const copy = localize(COPY, request.language);
    if (name.length > 80) return connectionRefused(422, { error: 'invalid_body', message: copy.invalidName, fields: { name: copy.invalidName } });
    const storage = this.#deps.storage();
    const connection = id === CLICKUP_CONNECTION_ID ? await storage.connections.get(request.orgId) : null;
    if (!connection) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const { name: _previous, ...rest } = connection.metadata;
    await storage.connections.upsert(request.orgId, {
      userId: connection.userId,
      data: connection.data,
      metadata: { ...rest, ...(name ? { name } : {}) },
    });
    return connectionOk({ name: name || clickUpMetadataOf(connection.metadata)?.username || copy.name });
  }

  async #impact(request: ConnectionRequest, label: string): Promise<RemovalImpact> {
    const copy = localize(COPY, request.language);
    const usage = await this.#usage(request.orgId);
    const factories = usage ?? [];
    return {
      title: copy.remove.title(label),
      body: factories.length ? copy.remove.body : `${copy.remove.body} ${usage ? copy.remove.nothing : ''}`.trim(),
      dependents: [],
      ...(factories.length ? { itemsLabel: copy.remove.itemsLabel } : {}),
      items: factories.map(factory => ({ label: copy.remove.factory(factory.name), outcome: 'stops' as const, outcomeLabel: copy.remove.stops(factory.lists) })),
      confirmLabel: copy.remove.confirm,
      cancelLabel: copy.remove.cancel,
      ...(usage ? {} : { warning: copy.routesUnavailable }),
      requiresConfirm: factories.length > 0,
    };
  }

  async removalImpact(request: ConnectionRequest, id: string): Promise<RemovalImpact | null> {
    if (id !== CLICKUP_CONNECTION_ID) return null;
    const read = await this.#read(request);
    if (!read) return null;
    return this.#impact(request, (await this.#view(request, read)).label);
  }

  async remove(request: ConnectionRequest, id: string, options: { confirm: boolean }): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    const storage = this.#deps.storage();
    const previous = id === CLICKUP_CONNECTION_ID ? await storage.connections.get(request.orgId) : null;
    if (!previous) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    if (!options.confirm) {
      const impact = await this.#impact(request, (typeof previous.metadata.name === 'string' && previous.metadata.name) || copy.name);
      if (impact.requiresConfirm) return connectionRefused(409, { error: 'connection_in_use', message: copy.remove.inUse, impact });
    }
    const removed = await storage.connections.delete(request.orgId);
    const before = clickUpTokenOf(previous.data);
    if (before) this.#deps.clients.forget(before);
    if (removed) request.audit('token_removed', {});
    return connectionOk({ message: copy.remove.done });
  }

  async detail(request: ConnectionRequest, id: string): Promise<ConnectionDetailSection[] | null> {
    const copy = localize(COPY, request.language);
    if (id !== CLICKUP_CONNECTION_ID) return null;
    const read = await this.#read(request);
    if (!read) return null;
    const stored = clickUpMetadataOf(read.connection.metadata);
    const workspaces = read.workspaces.length ? read.workspaces : (stored?.workspaces ?? []);
    await this.#deps.intake.ensureReady();
    const config = await this.#deps.intake.getConfig({ orgId: request.orgId, integrationIds: ['clickup'] });
    return [
      {
        type: 'facts',
        title: copy.detail.title,
        rows: [
          ...(stored?.username ? [{ label: copy.detail.account, value: stored.username }] : []),
          ...(workspaces.length ? [{ label: copy.detail.workspaces, value: workspaces.join(', ') }] : []),
          { label: copy.detail.pace, value: copy.detail.interval(this.#deps.intervalSeconds) },
        ],
      },
      {
        type: 'settings',
        id: 'intake',
        title: copy.settings.title,
        description: copy.settings.description,
        fields: [
          {
            name: 'enabled',
            displayName: copy.settings.sync,
            description: copy.settings.syncHelp,
            type: 'boolean',
            required: false,
            value: config.clickup?.enabled === true,
            ...(read.error ? { disabled: { reason: copy.settings.notConnected } } : {}),
          },
        ],
      },
    ];
  }

  /** The import switch: the organization's intake selection for ClickUp, as Settings › Надходження saves it. */
  async updateSettings(
    request: ConnectionRequest,
    id: string,
    section: string,
    values: ConnectionSettingsValues,
  ): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    if (id !== CLICKUP_CONNECTION_ID || section !== 'intake' || typeof values.enabled !== 'boolean') {
      return connectionRefused(400, { error: 'invalid_body', message: copy.notFound });
    }
    const intake = this.#deps.intake;
    await intake.ensureReady();
    const config = await intake.getConfig({ orgId: request.orgId, integrationIds: ['clickup'] });
    const current = config.clickup ?? { enabled: false, sourceIds: null };
    await intake.saveConfig({ orgId: request.orgId, config: { ...config, clickup: { ...current, enabled: values.enabled } } });
    return connectionOk({ message: copy.settings.saved(values.enabled) });
  }
}
