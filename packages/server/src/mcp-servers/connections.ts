/**
 * MCP servers as a connector of Settings › Підключення (ADR-0035): each server the asking Factory
 * has access to is a Factory-scoped connection (the organization keeps the server; «Відв'язати»
 * drops this Factory's access, «Видалити» deletes the server for every Factory after naming them).
 * Adding one is the one custom editor (`editor: mcp-server` on a method — the catalog's servers and
 * an own one), or linking a server the organization already has (a select). A server an integration
 * runs under the hood (`owner`) is that integration's connection and never listed here. Everything
 * the person reads is written here, in the request's language.
 */

import type { McpCatalogEntry, McpErrorKind, McpServerInput, McpServerView } from '@factory/core';
import { mcpServerState } from '@factory/core';
import { connectionOk, connectionRefused, localize } from '@factory/integrations';
import type {
  ConnectionCopy,
  ConnectionDetailSection,
  ConnectionOutcome,
  ConnectionRequest,
  ConnectMethod,
  ConnectorConnection,
  ConnectorConnectResult,
  ConnectorDescription,
  IntegrationConnections,
  RemovalImpact,
} from '@factory/integrations';
import type { FactoryProjectsStorage, McpServersStorage } from '@factory/store';

import type { McpCredentials } from './credentials.ts';
import type { McpServerHub } from './hub.ts';
import type { ManagedMcpServers } from './managed.ts';
import type { McpServerRoutesOptions } from './routes.ts';

type State = ReturnType<typeof mcpServerState>;

interface Copy {
  name: string;
  summary: string;
  tools: (count: number) => string;
  toolsGeneric: string;
  states: Record<State, string>;
  errors: Record<McpErrorKind, string>;
  link: { label: string; description: string; field: string; none: string; submit: string; linkedTitle: (name: string) => string };
  custom: { label: string; description: string };
  check: { label: string; connected: (count: number) => string; failed: (error: string) => string };
  factoryRequired: string;
  inEditor: string;
  notFound: string;
  invalidName: string;
  usedBy: (count: number) => string;
  unlinked: string;
  remove: { title: (name: string) => string; body: string; factory: (name: string) => string; confirm: string; cancel: string; inUse: string; done: string };
  detail: { facts: string; runs: string; transport: { catalog: (entry: string) => string; http: string; stdio: string }; checked: string; never: string; calls: string; columns: [string, string, string]; noCalls: string; outcome: { ok: string; error: string }; editor: string };
}

const COPY: ConnectionCopy<Copy> = {
  en: {
    name: 'MCP servers',
    summary: 'Third-party and own MCP servers: tools agents call, with a policy per tool.',
    tools: count => `${count} ${count === 1 ? 'tool' : 'tools'}`,
    toolsGeneric: 'Tools',
    states: { ok: 'Working', error: 'Error', needs_auth: 'Needs access', unchecked: 'Not checked yet', disabled: 'Off' },
    errors: {
      version_mismatch: 'The installed package version differs from the catalog’s; update Factory’s dependencies.',
      missing_input: 'A required field is empty.',
      auth_denied: 'The account was refused access; give it the role the server needs.',
      timeout: 'The server did not answer in time.',
      spawn_failed: 'The server would not start.',
      other: 'Something went wrong.',
    },
    link: {
      label: 'A server of the organization',
      description: 'Give this Factory access to a server the organization already has, for every session kind.',
      field: 'Server',
      none: 'Every server of the organization is already linked to this Factory.',
      submit: 'Link',
      linkedTitle: name => `${name} is linked to this Factory`,
    },
    custom: { label: 'Own MCP server', description: 'A remote URL or a local command.' },
    check: { label: 'Check the connection', connected: count => `Reconnected: ${count} ${count === 1 ? 'tool' : 'tools'}`, failed: error => `Could not reconnect: ${error}` },
    factoryRequired: 'Open Connections of a Factory to link a server to it.',
    inEditor: 'This server is set up in its editor.',
    notFound: 'This MCP server no longer exists.',
    invalidName: 'A name is up to 80 characters.',
    usedBy: count => `Factories with access: ${count}`,
    unlinked: 'Unlinked from this Factory. The organization’s server stays.',
    remove: {
      title: name => `Delete “${name}”?`,
      body: 'The server is deleted for the whole organization, with its secrets.',
      factory: name => `Factory «${name}» loses its tools`,
      confirm: 'Delete',
      cancel: 'Cancel',
      inUse: 'Factories still use this server; confirm to delete it for all of them.',
      done: 'Connection deleted',
    },
    detail: {
      facts: 'Server',
      runs: 'Runs as',
      transport: { catalog: entry => `${entry} (catalog)`, http: 'Remote URL', stdio: 'Local command' },
      checked: 'Checked',
      never: 'not yet',
      calls: 'Recent calls',
      columns: ['When', 'Tool', 'Outcome'],
      noCalls: 'No agent called its tools yet.',
      outcome: { ok: 'OK', error: 'Error' },
      editor: 'Server',
    },
  },
  uk: {
    name: 'MCP-сервери',
    summary: 'Сторонні й власні MCP-сервери: інструменти, які кличуть агенти, з політикою на кожен.',
    tools: count => `Інструментів: ${count}`,
    toolsGeneric: 'Інструменти',
    states: { ok: 'Працює', error: 'Помилка', needs_auth: 'Потрібен доступ', unchecked: 'Ще не перевірявся', disabled: 'Вимкнено' },
    errors: {
      version_mismatch: 'Встановлена версія пакета не та, що в каталозі; оновіть залежності Factory.',
      missing_input: 'Не заповнено обов’язкове поле.',
      auth_denied: 'Акаунту відмовлено в доступі; видайте йому роль, потрібну серверу.',
      timeout: 'Сервер не відповів вчасно.',
      spawn_failed: 'Сервер не запускається.',
      other: 'Щось пішло не так.',
    },
    link: {
      label: 'Сервер організації',
      description: 'Дати цій Factory доступ до сервера, який організація вже має, для всіх видів сесій.',
      field: 'Сервер',
      none: 'Усі сервери організації вже прив’язано до цієї Factory.',
      submit: 'Прив’язати',
      linkedTitle: name => `${name} прив’язано до цієї Factory`,
    },
    custom: { label: 'Власний MCP-сервер', description: 'Віддалена адреса або локальна команда.' },
    check: { label: 'Перевірити з’єднання', connected: count => `Перепідключено, інструментів: ${count}`, failed: error => `Не вдалося перепідключити: ${error}` },
    factoryRequired: 'Відкрийте «Підключення» Factory, щоб прив’язати до неї сервер.',
    inEditor: 'Цей сервер налаштовується в його редакторі.',
    notFound: 'Цього MCP-сервера вже немає.',
    invalidName: 'Назва — до 80 символів.',
    usedBy: count => `Мають доступ Factory: ${count}`,
    unlinked: 'Відв’язано від цієї Factory. Сервер організації лишився.',
    remove: {
      title: name => `Видалити «${name}»?`,
      body: 'Сервер видаляється для всієї організації разом із секретами.',
      factory: name => `Factory «${name}» втратить його інструменти`,
      confirm: 'Видалити',
      cancel: 'Скасувати',
      inUse: 'Factory ще користуються цим сервером; підтвердьте, щоб видалити його для всіх.',
      done: 'Підключення видалено',
    },
    detail: {
      facts: 'Сервер',
      runs: 'Запускається як',
      transport: { catalog: entry => `${entry} (каталог)`, http: 'Віддалена адреса', stdio: 'Локальна команда' },
      checked: 'Перевірено',
      never: 'ще ні',
      calls: 'Останні виклики',
      columns: ['Коли', 'Інструмент', 'Результат'],
      noCalls: 'Агенти ще не кликали його інструментів.',
      outcome: { ok: 'Успіх', error: 'Помилка' },
      editor: 'Сервер',
    },
  },
};

const TONE: Record<State, 'ok' | 'warning' | 'error' | 'idle'> = { ok: 'ok', error: 'error', needs_auth: 'warning', unchecked: 'idle', disabled: 'idle' };
const ALL_SESSIONS = ['chat', 'personal', 'cards'] as const;

export interface McpConnectionsDeps {
  servers: Pick<McpServersStorage, 'list' | 'get' | 'update' | 'delete'>;
  hub: Pick<McpServerHub, 'reconnect'>;
  credentials: Pick<McpCredentials, 'options'>;
  catalog: readonly McpCatalogEntry[];
  projects: Pick<FactoryProjectsStorage, 'get'>;
  managed?: Pick<ManagedMcpServers, 'ensure'>;
  audit?: McpServerRoutesOptions['audit'];
  auditLog?: McpServerRoutesOptions['auditLog'];
}

const inputOf = (server: McpServerView): McpServerInput => ({
  name: server.name,
  label: server.label,
  launch: server.launch,
  assignments: server.assignments,
  toolPolicies: server.toolPolicies,
  maskPersonalData: server.maskPersonalData,
  enabled: server.enabled,
  ...(server.callTimeoutMs ? { callTimeoutMs: server.callTimeoutMs } : {}),
});

/** The organization's own and third-party MCP servers, one connection per server a Factory has access to. */
export class McpConnections implements IntegrationConnections {
  readonly #deps: McpConnectionsDeps;

  constructor(deps: McpConnectionsDeps) {
    this.#deps = deps;
  }

  async #servers(orgId: string): Promise<McpServerView[]> {
    await this.#deps.managed?.ensure(orgId);
    return (await this.#deps.servers.list(orgId)).filter(server => !server.owner);
  }

  #checkMethod(copy: Copy): ConnectMethod {
    return { id: 'check', label: copy.check.label, authKind: 'apiKey', fields: [], available: true };
  }

  async describe(request: ConnectionRequest): Promise<ConnectorDescription> {
    const copy = localize(COPY, request.language);
    const language = request.language;
    const servers = request.factoryProjectId ? await this.#servers(request.orgId) : [];
    const linkable = servers.filter(server => !server.assignments.some(assignment => assignment.factoryProjectId === request.factoryProjectId));
    const editorMethod = (id: string, label: string, description: string, params: Record<string, string>): ConnectMethod => ({
      id,
      label,
      description,
      authKind: 'apiKey',
      available: true,
      editor: { component: 'mcp-server', params: { ...params, ...(request.factoryProjectId ? { factoryProjectId: request.factoryProjectId } : {}) } },
    });
    return {
      name: copy.name,
      icon: 'mcp',
      description: copy.summary,
      category: 'tools' as const,
      mcp: true,
      provides: [{ key: 'tools', label: copy.toolsGeneric }],
      capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true, supportsRevoke: false },
      methods: [
        {
          id: 'link',
          label: copy.link.label,
          description: copy.link.description,
          authKind: 'apiKey' as const,
          fields: [
            {
              name: 'serverId',
              displayName: copy.link.field,
              type: 'select' as const,
              options: linkable.map(server => ({ value: server.id, label: server.label })),
              required: true,
            },
          ],
          submitLabel: copy.link.submit,
          available: !request.factoryProjectId ? { reason: copy.factoryRequired } : linkable.length === 0 ? { reason: copy.link.none } : (true as const),
        },
        // Servers an integration runs under the hood are that integration's, not a choice here.
        ...this.#deps.catalog
          .filter(entry => !entry.integration)
          .map(entry => editorMethod(`entry:${entry.id}`, entry.label[language], entry.summary[language], { entry: entry.id })),
        editorMethod('custom', copy.custom.label, copy.custom.description, { custom: 'true' }),
      ],
    };
  }

  async #view(request: ConnectionRequest, server: McpServerView, accountNames: Map<string, string>): Promise<ConnectorConnection> {
    const copy = localize(COPY, request.language);
    const state = mcpServerState(server);
    const health = server.health;
    const failure =
      (state === 'error' || state === 'needs_auth') && health
        ? [health.errorKind && health.errorKind !== 'other' ? copy.errors[health.errorKind] : undefined, health.error ? `(${health.error})` : undefined]
            .filter(Boolean)
            .join(' ') || copy.errors.other
        : undefined;
    const credential = server.launch.transport === 'catalog' ? Object.values(server.launch.credentials)[0] : undefined;
    const account = credential ? accountNames.get(`${credential.kind}:${credential.id}`) : undefined;
    const others = server.assignments.filter(assignment => assignment.factoryProjectId !== request.factoryProjectId).length;
    return {
      id: server.id,
      status: state === 'needs_auth' ? 'needs_reauth' : 'active',
      displayName: server.label,
      accountLabel: account ?? null,
      label: server.label,
      mcp: true,
      provides: health?.tools.length ? [{ key: 'tools', label: copy.tools(health.tools.length) }] : [],
      state: { tone: TONE[state], label: copy.states[state], ...(failure ? { message: failure } : {}) },
      scope: 'factory',
      createdAt: server.createdAt,
      createdBy: server.createdBy,
      ...(others > 0 ? { dependents: copy.usedBy(others + 1) } : {}),
      actions: {
        rename: true,
        reconnect: { method: this.#checkMethod(copy) },
        ...(request.factoryProjectId ? { unlink: true } : {}),
        remove: true,
      },
    };
  }

  async #accountNames(orgId: string): Promise<Map<string, string>> {
    const options = await this.#deps.credentials.options(orgId);
    return new Map(Object.entries(options).flatMap(([kind, list]) => (list ?? []).map(option => [`${kind}:${option.id}`, option.name] as const)));
  }

  async list(request: ConnectionRequest): Promise<ConnectorConnection[]> {
    const servers = (await this.#servers(request.orgId)).filter(
      server => !request.factoryProjectId || server.assignments.some(assignment => assignment.factoryProjectId === request.factoryProjectId),
    );
    const names = await this.#accountNames(request.orgId);
    return Promise.all(servers.map(server => this.#view(request, server, names)));
  }

  async #server(request: ConnectionRequest, id: string): Promise<McpServerView | null> {
    const server = await this.#deps.servers.get(request.orgId, id);
    return server && !server.owner ? server : null;
  }

  async #record(request: ConnectionRequest, action: 'created' | 'updated' | 'deleted' | 'reconnected', server: Pick<McpServerView, 'id' | 'label'>, metadata?: Record<string, unknown>) {
    await this.#deps.audit?.record({
      orgId: request.orgId,
      actorId: request.userId || 'local',
      action: `factory.mcp_server.${action}`,
      targets: [{ type: 'mcp_server', id: server.id, name: server.label }],
      ...(metadata ? { metadata } : {}),
    });
  }

  async connect(request: ConnectionRequest, methodId: string, input: Record<string, string>): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    if (methodId !== 'link') return connectionRefused(400, { error: 'use_editor', message: copy.inEditor });
    const factoryProjectId = request.factoryProjectId;
    if (!factoryProjectId || !(await this.#deps.projects.get({ orgId: request.orgId, id: factoryProjectId }))) {
      return connectionRefused(400, { error: 'factory_required', message: copy.factoryRequired });
    }
    const server = input.serverId ? await this.#server(request, input.serverId) : null;
    if (!server) return connectionRefused(422, { error: 'not_found', message: copy.notFound, fields: { serverId: copy.notFound } });
    const updated = server.assignments.some(assignment => assignment.factoryProjectId === factoryProjectId)
      ? server
      : await this.#deps.servers.update(
          request.orgId,
          server.id,
          { ...inputOf(server), assignments: [...server.assignments, { factoryProjectId, sessions: [...ALL_SESSIONS] }] },
          request.userId || 'local',
        );
    if (!updated) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    await this.#record(request, 'updated', updated);
    return connectionOk({
      type: 'connected',
      connection: await this.#view(request, updated, await this.#accountNames(request.orgId)),
      title: copy.link.linkedTitle(updated.label),
    });
  }

  /** «Перепідключити»: stops every running instance and checks the server again. */
  async reconnect(request: ConnectionRequest, id: string): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const server = await this.#server(request, id);
    if (!server) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const status = await this.#deps.hub.reconnect(request.orgId, id);
    if (!status) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    await this.#record(request, 'reconnected', server, { connected: status.connected });
    if (!status.connected) {
      const reason = status.errorKind && status.errorKind !== 'other' ? copy.errors[status.errorKind] : (status.error ?? copy.errors.other);
      return connectionRefused(502, { error: 'not_connected', message: copy.check.failed(reason) });
    }
    const fresh = (await this.#server(request, id)) ?? server;
    return connectionOk({
      type: 'connected',
      connection: await this.#view(request, fresh, await this.#accountNames(request.orgId)),
      title: copy.check.connected(status.toolCount),
    });
  }

  async rename(request: ConnectionRequest, id: string, name: string): Promise<ConnectionOutcome<{ name: string }>> {
    const copy = localize(COPY, request.language);
    if (!name || name.length > 80) return connectionRefused(422, { error: 'invalid_body', message: copy.invalidName, fields: { name: copy.invalidName } });
    const server = await this.#server(request, id);
    if (!server) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const updated = await this.#deps.servers.update(request.orgId, id, { ...inputOf(server), label: name }, request.userId || 'local');
    if (!updated) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    await this.#record(request, 'updated', updated);
    return connectionOk({ name: updated.label });
  }

  async unlink(request: ConnectionRequest, id: string): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    const server = await this.#server(request, id);
    if (!server || !request.factoryProjectId) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const updated = await this.#deps.servers.update(
      request.orgId,
      id,
      { ...inputOf(server), assignments: server.assignments.filter(assignment => assignment.factoryProjectId !== request.factoryProjectId) },
      request.userId || 'local',
    );
    if (!updated) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    await this.#record(request, 'updated', updated);
    return connectionOk({ message: copy.unlinked });
  }

  async #impact(request: ConnectionRequest, server: McpServerView): Promise<RemovalImpact> {
    const copy = localize(COPY, request.language);
    const factoryIds = [...new Set(server.assignments.map(assignment => assignment.factoryProjectId))];
    const names = await Promise.all(
      factoryIds.map(async id => (await this.#deps.projects.get({ orgId: request.orgId, id }).catch(() => null))?.name ?? id),
    );
    return {
      title: copy.remove.title(server.label),
      body: copy.remove.body,
      dependents: names.map(name => ({ label: copy.remove.factory(name) })),
      items: [],
      confirmLabel: copy.remove.confirm,
      cancelLabel: copy.remove.cancel,
      requiresConfirm: factoryIds.length > 0,
    };
  }

  async removalImpact(request: ConnectionRequest, id: string): Promise<RemovalImpact | null> {
    const server = await this.#server(request, id);
    return server ? this.#impact(request, server) : null;
  }

  async remove(request: ConnectionRequest, id: string, options: { confirm: boolean }): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    const server = await this.#server(request, id);
    if (!server) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    if (!options.confirm && server.assignments.length > 0) {
      return connectionRefused(409, { error: 'server_in_use', message: copy.remove.inUse, impact: await this.#impact(request, server) });
    }
    if (!(await this.#deps.servers.delete(request.orgId, id))) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    await this.#record(request, 'deleted', server);
    return connectionOk({ message: copy.remove.done });
  }

  async detail(request: ConnectionRequest, id: string): Promise<ConnectionDetailSection[] | null> {
    const copy = localize(COPY, request.language);
    const server = await this.#server(request, id);
    if (!server) return null;
    const launch = server.launch;
    const entry = launch.transport === 'catalog' ? this.#deps.catalog.find(candidate => candidate.id === launch.entry) : undefined;
    const runs =
      launch.transport === 'catalog'
        ? copy.detail.transport.catalog(entry ? entry.label[request.language] : launch.entry)
        : launch.transport === 'http'
          ? copy.detail.transport.http
          : copy.detail.transport.stdio;
    const calls = await this.#calls(request, id);
    return [
      {
        type: 'facts',
        title: copy.detail.facts,
        rows: [
          { label: copy.detail.runs, value: runs },
          { label: copy.detail.checked, value: server.health?.checkedAt ?? copy.detail.never },
        ],
      },
      { type: 'custom', component: 'mcp-server', title: copy.detail.editor, params: { serverId: server.id } },
      {
        type: 'table',
        title: copy.detail.calls,
        columns: [...copy.detail.columns],
        rows: calls.map(call => ({ cells: [call.at, call.tool, call.ok ? copy.detail.outcome.ok : copy.detail.outcome.error] })),
        empty: copy.detail.noCalls,
      },
    ];
  }

  async #calls(request: ConnectionRequest, id: string): Promise<Array<{ at: string; tool: string; ok: boolean }>> {
    if (!this.#deps.auditLog) return [];
    const page = await this.#deps.auditLog.list({
      orgId: request.orgId,
      actions: ['factory.mcp_server.tool_called', 'factory.mcp_server.tool_tried'],
      limit: 200,
    });
    return page.events
      .filter(event => event.targets.some(target => target.type === 'mcp_server' && target.id === id))
      .slice(0, 20)
      .map(event => ({ at: new Date(event.occurredAt).toISOString(), tool: String(event.metadata.tool ?? ''), ok: event.metadata.outcome !== 'error' }));
  }
}
