/**
 * The connections facet of the integration contract (ADR-0035): what an integration tells the
 * Factory about the accounts it connects, so Settings › Підключення can show and change them without
 * knowing any provider. Each integration that keeps connections implements {@link IntegrationConnections};
 * {@link buildConnectionRoutes} serves all of them through one set of `/web/connections` routes.
 *
 * The facet follows Mastra's tool-provider connection surface (`@mastra/core/tool-provider`:
 * `authorize → { url, authId }`, `getAuthStatus`, `ConnectionField`, `getHealth`, capabilities) and
 * extends it with what Factory's admin page needs (ADR-0035).
 *
 * The facet decides everything the person sees and may do: the connect methods (descriptors the UI
 * renders as forms or authorize redirects), each connection's state and allowed actions, what removing one
 * moves or unlinks, and every string, in the request's language. The UI holds no provider knowledge.
 */

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';

import {
  CONNECTION_LANGUAGES,
  CONNECTIONS_CONTRACT_VERSION,
  contractMajor,
  DEFAULT_CONNECTION_PERMISSIONS,
  connectRequestSchema,
  reconnectRequestSchema,
  renameConnectionSchema,
  updateConnectionSettingsSchema,
} from '@factory/contracts';
import type {
  AuthFlowStatus,
  ConnectionActivityCall,
  ConnectionActivityResponse,
  ConnectionActionsView,
  ConnectionBlocked,
  ConnectionDetailSection,
  ConnectionPermission,
  ConnectionPermissions,
  ConnectionErrorBody,
  ConnectionLanguage,
  ConnectionSettingsValues,
  ConnectionView,
  ConnectorRef,
  ConnectSession,
  ConnectWaiting,
  ConnectorView,
  RemovalImpact,
} from '@factory/contracts';
import type { AuditEmitter } from '@factory/feed';
import type { RouteAuth } from '@factory/http';
import type { AuditAction } from '@factory/store';
import { declareAccess } from '@factory/http';
import type { RouteAccess } from '@factory/http';

export type * from '@factory/contracts/connections';

/** Audit actions a connector records for its connections (`factory.integration.*`). */
export type ConnectionAuditAction = 'token_connected' | 'token_removed' | 'connection_removed';

/** Who asks, in which language, and on behalf of which Factory. Built by the registry per request. */
export interface ConnectionRequest {
  orgId: string;
  userId: string;
  /** Organization admin (or a server without auth): may connect, rename, reconnect, remove. */
  admin: boolean;
  language: ConnectionLanguage;
  /** The Factory whose page asks; Factory-scoped connections are listed for it. */
  factoryProjectId?: string;
  /**
   * Records an audit event for this request, targeting the connector: a short integration action
   * (`factory.integration.<action>`), or a full action of another namespace. Never throws.
   */
  audit(action: ConnectionAuditAction | AuditAction, metadata: Record<string, unknown>, options?: { factoryProjectId?: string }): void;
}

/** A connector as it describes itself; the registry adds its id and its resolved permissions. */
export type ConnectorDescription = Omit<ConnectorView, 'id' | 'permissions'>;

/**
 * A named permission a connector defines: whether this request may act on the connection `localId`
 * (absent for a new connection), or why not. The registry calls it; the connector checks nothing else.
 */
export type ConnectionPolicy = (request: ConnectionRequest, localId: string | undefined) => Promise<true | ConnectionBlocked>;

export { DEFAULT_CONNECTION_PERMISSIONS };

/** A change the registry gates. */
export type ConnectionChange = Exclude<keyof ConnectionPermissions, 'settings'> | 'settings';

/** A connection as its connector lists it: its own id, without the connector's name and logo. */
export type ConnectorConnection = Omit<ConnectionView, 'id' | 'connector'> & { id: string };

export type ConnectorConnectResult =
  | { type: 'authorize'; url?: string; authId?: string; session?: ConnectSession; waiting?: ConnectWaiting }
  | { type: 'connected'; connection: ConnectorConnection; title: string; message?: string };

/** A facet call's result: the value, or the status and body to refuse with. */
export type ConnectionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422 | 502 | 503; body: ConnectionErrorBody };

export const connectionOk = <T>(value: T): ConnectionOutcome<T> => ({ ok: true, value });
export const connectionRefused = (
  status: 400 | 403 | 404 | 409 | 422 | 502 | 503,
  body: ConnectionErrorBody,
): ConnectionOutcome<never> => ({ ok: false, status, body });

/**
 * The connections facet. Ids are the connector's own (the registry prefixes `<integration id>:`).
 * Only `describe`, `list` and `connect` are required; an action a connector does not implement is
 * one it never offers in `actions`.
 */
export interface IntegrationConnections {
  /**
   * The contract version this connector implements ({@link CONNECTIONS_CONTRACT_VERSION}). The
   * registry serves only its own major; absent means the version it was built with (first-party).
   */
  readonly contractVersion?: string;
  /**
   * Who may make each change (`member`, `admin`, or one of `policies`); what is left out is an
   * organization admin's ({@link DEFAULT_CONNECTION_PERMISSIONS}). The registry enforces it on every
   * route and turns a refused action, method or setting into `{ reason }` in what it serves: a
   * connector does not check roles itself.
   */
  readonly permissions?: Partial<ConnectionPermissions>;
  /** The named policies `permissions` refers to. */
  readonly policies?: Readonly<Record<string, ConnectionPolicy>>;
  /** Name, logo key, category, capabilities and connect methods, for «Додати підключення». */
  describe(request: ConnectionRequest): ConnectorDescription | Promise<ConnectorDescription>;
  /** The organization's connections (and the asking Factory's links). */
  list(request: ConnectionRequest): Promise<ConnectorConnection[]>;
  connect(
    request: ConnectionRequest,
    methodId: string,
    input: Record<string, string>,
  ): Promise<ConnectionOutcome<ConnectorConnectResult>>;
  /**
   * Where an `authorize` flow stands, by the `authId` it returned (`ToolProvider.getAuthStatus`), with
   * why it failed when the connector knows; null: unknown.
   */
  getAuthStatus?(request: ConnectionRequest, authId: string): Promise<AuthFlowStatus | { status: AuthFlowStatus; message?: string } | null>;
  reconnect?(
    request: ConnectionRequest,
    id: string,
    input: Record<string, string>,
  ): Promise<ConnectionOutcome<ConnectorConnectResult>>;
  rename?(request: ConnectionRequest, id: string, name: string): Promise<ConnectionOutcome<{ name: string }>>;
  /** What removing it would do; null when it does not exist. */
  removalImpact?(request: ConnectionRequest, id: string): Promise<RemovalImpact | null>;
  /**
   * Removes it. Without `confirm`, a connection something depends on is refused (409) with its
   * impact, so no client removes what it never showed.
   */
  remove?(request: ConnectionRequest, id: string, options: { confirm: boolean }): Promise<ConnectionOutcome<{ message: string }>>;
  /** Drops the asking Factory's link and keeps the organization's account. */
  unlink?(request: ConnectionRequest, id: string): Promise<ConnectionOutcome<{ message: string }>>;
  /**
   * Saves a `settings` section of the detail page, gated by `permissions.settings` (per section id
   * when it is a map); a field the connector itself cannot change here is `disabled` with a reason.
   */
  updateSettings?(
    request: ConnectionRequest,
    id: string,
    section: string,
    values: ConnectionSettingsValues,
  ): Promise<ConnectionOutcome<{ message: string }>>;
  /** The detail page's sections; null when it does not exist. */
  detail?(request: ConnectionRequest, id: string): Promise<ConnectionDetailSection[] | null>;
  /**
   * The calls agents made through its connections for `request.factoryProjectId` since `since`,
   * newest first, at most `limit` (counts cover them all): «Активність». Absent: it has none.
   */
  activity?(request: ConnectionRequest, window: { since: Date; limit: number }): Promise<ConnectorActivity>;
}

/** A connector's activity in a window; the registry adds the connector and global ids. */
export interface ConnectorActivity {
  total: number;
  errors: number;
  truncated: boolean;
  calls: Array<Omit<ConnectionActivityCall, 'connectionId' | 'connector'> & { connectionId: string }>;
}

/** The newest calls «Активність» shows, and the longest window it reads. */
export const ACTIVITY_CALLS = 50;
export const ACTIVITY_MAX_HOURS = 24 * 7;

/** The language a request asks for (`Accept-Language`, first supported tag wins); English otherwise. */
export function connectionLanguage(header: string | undefined | null): ConnectionLanguage {
  for (const part of (header ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase().split('-')[0];
    const found = CONNECTION_LANGUAGES.find(language => language === tag);
    if (found) return found;
  }
  return 'en';
}

/** A connector's copy catalog: one entry per language, the same shape in each. */
export type ConnectionCopy<T> = Record<ConnectionLanguage, T>;

export function localize<T>(copy: ConnectionCopy<T>, language: ConnectionLanguage): T {
  return copy[language] ?? copy.en;
}

const COPY: ConnectionCopy<{
  unauthorized: string;
  organizationRequired: string;
  adminOnly: string;
  policyMissing: string;
  notFound: string;
  unknownConnector: string;
  invalidBody: string;
  listFailed: (error: string) => string;
  organizationWide: string;
  unsupported: string;
  contract: (version: string, server: string) => string;
}> = {
  en: {
    unauthorized: 'Sign in to see connections.',
    organizationRequired: 'Connections belong to an organization. Personal accounts cannot connect.',
    adminOnly: 'Only organization admins change connections.',
    policyMissing: 'This server cannot tell whether you may do that.',
    notFound: 'This connection no longer exists.',
    unknownConnector: 'This integration is not available on this server.',
    invalidBody: 'The request is not what this action takes.',
    listFailed: error => `Could not read the connections: ${error}`,
    organizationWide: 'The whole organization',
    unsupported: 'This connection cannot do that.',
    contract: (version, server) => `Built for connections contract ${version}; this server speaks ${server}. Update the connector.`,
  },
  uk: {
    unauthorized: 'Увійдіть, щоб бачити підключення.',
    organizationRequired: 'Підключення належать організації. Особистий акаунт не може підключати.',
    adminOnly: 'Змінює адміністратор організації.',
    policyMissing: 'Сервер не може визначити, чи вам це можна.',
    notFound: 'Цього підключення вже немає.',
    unknownConnector: 'Ця інтеграція недоступна на цьому сервері.',
    invalidBody: 'Запит не такий, як ця дія приймає.',
    listFailed: error => `Не вдалося прочитати підключення: ${error}`,
    organizationWide: 'Уся організація',
    unsupported: 'Це підключення так не вміє.',
    contract: (version, server) => `Зроблено для контракту підключень ${version}; сервер говорить ${server}. Оновіть конектор.`,
  },
};

/** One registered connector: the integration's id and its facet. */
export interface ConnectorRegistration {
  id: string;
  connections: IntegrationConnections;
}

export interface ConnectionRoutesOptions {
  auth: RouteAuth;
  connectors: readonly ConnectorRegistration[];
  emitAudit?: AuditEmitter['emit'];
}

type RouteContext = Context;

/** Splits `<connector>:<own id>`; the connector's own id may itself hold colons. */
function splitConnectionId(id: string): { connectorId: string; localId: string } | null {
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) return null;
  return { connectorId: id.slice(0, at), localId: id.slice(at + 1) };
}

/**
 * `/web/connections`: one registry over every connector's facet. Org-scoped (a personal account is
 * refused), readable by members; every change takes the permission its connector declares
 * (`IntegrationConnections.permissions`, an admin's by default), checked here; every refusal and every
 * string is in the request's language.
 */
export function buildConnectionRoutes(...args: Parameters<typeof buildConnectionRoutesUndeclared>): ApiRoute[] {
  return declareAccess(buildConnectionRoutesUndeclared(...args), ROUTE_ACCESS);
}

function buildConnectionRoutesUndeclared(options: ConnectionRoutesOptions): ApiRoute[] {
  const { auth, connectors, emitAudit } = options;
  /** Whether the registry speaks the connector's contract major; one that does not is served nowhere, only named. */
  const speaks = (connector: ConnectorRegistration) =>
    contractMajor(connector.connections.contractVersion ?? CONNECTIONS_CONTRACT_VERSION) === contractMajor(CONNECTIONS_CONTRACT_VERSION);
  /** A connector named by its id alone, when it cannot describe itself. */
  const unnamed = (connector: ConnectorRegistration): ConnectorRef => ({ id: connector.id, name: connector.id, icon: connector.id });
  const unsupportedFailure = (connector: ConnectorRegistration, language: ConnectionLanguage) => ({
    connector: unnamed(connector),
    message: localize(COPY, language).contract(connector.connections.contractVersion ?? '?', CONNECTIONS_CONTRACT_VERSION),
  });
  const byId = new Map(connectors.filter(speaks).map(connector => [connector.id, connector]));

  const refuse = (c: RouteContext, status: number, body: ConnectionErrorBody) =>
    c.json(body, status as 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503);

  /** The request's org, user, language and admin bit, or the response refusing it. */
  const resolve = async (
    c: RouteContext,
    connectorId?: string,
  ): Promise<{ request: ConnectionRequest; language: ConnectionLanguage } | { response: Response }> => {
    const language = connectionLanguage(c.req.header('accept-language'));
    const copy = localize(COPY, language);
    await auth.ensureUser(c);
    const tenant = auth.tenant(c);
    if (!tenant) return { response: refuse(c, 401, { error: 'unauthorized', message: copy.unauthorized }) };
    if (!tenant.orgId) {
      return { response: refuse(c, 403, { error: 'organization_required', message: copy.organizationRequired }) };
    }
    const orgId = tenant.orgId;
    const admin = !auth.enabled() || (await auth.can(c, 'connections.manage', orgId));
    const factoryProjectId = c.req.query('factoryProjectId');
    const request: ConnectionRequest = {
      orgId,
      userId: tenant.userId,
      admin,
      language,
      ...(factoryProjectId ? { factoryProjectId } : {}),
      audit: (action, metadata, options) =>
        void Promise.resolve(
          emitAudit?.({
            context: c,
            input: {
              action: action.startsWith('factory.') ? (action as AuditAction) : (`factory.integration.${action}` as AuditAction),
              ...(options?.factoryProjectId ? { factoryProjectId: options.factoryProjectId } : {}),
              targets: [{ type: 'integration', id: connectorId ?? 'connections' }],
              metadata,
            },
          }),
        ).catch(() => undefined),
    };
    return { request, language };
  };

  /** The permission a change of `connector` takes (for `settings`, of `section` when they differ per section). */
  const permissionOf = (connector: ConnectorRegistration, change: ConnectionChange, section?: string): ConnectionPermission => {
    const declared = { ...DEFAULT_CONNECTION_PERMISSIONS, ...connector.connections.permissions };
    if (change !== 'settings') return declared[change];
    const settings = declared.settings;
    if (typeof settings === 'string' || 'policy' in settings) return settings as ConnectionPermission;
    return (section ? (settings as Record<string, ConnectionPermission>)[section] : undefined) ?? DEFAULT_CONNECTION_PERMISSIONS.connect;
  };

  /** Whether this request may make `change` (on `localId`), or why not: the one place roles are checked. */
  const permitted = async (
    connector: ConnectorRegistration,
    request: ConnectionRequest,
    change: ConnectionChange,
    localId: string | undefined,
    section?: string,
  ): Promise<true | ConnectionBlocked> => {
    const copy = localize(COPY, request.language);
    const permission = permissionOf(connector, change, section);
    if (permission === 'member') return true;
    if (permission === 'admin') return request.admin ? true : { reason: copy.adminOnly };
    const policy = connector.connections.policies?.[permission.policy];
    if (!policy) return { reason: copy.policyMissing };
    return policy(request, localId);
  };

  /** A connection's actions with every one the request may not take turned into its reason. */
  const gateActions = async (
    connector: ConnectorRegistration,
    request: ConnectionRequest,
    connection: ConnectorConnection,
  ): Promise<ConnectorConnection> => {
    const actions: ConnectionActionsView = { ...connection.actions };
    for (const change of ['rename', 'reconnect', 'remove', 'unlink'] as const) {
      const action = actions[change];
      if (action === undefined || (typeof action === 'object' && 'reason' in action)) continue;
      const allowed = await permitted(connector, request, change, connection.id);
      if (allowed !== true) (actions as Record<string, unknown>)[change] = allowed;
    }
    return { ...connection, actions };
  };

  /** Settings sections with every field of a section the request may not save disabled with the reason. */
  const gateSections = async (
    connector: ConnectorRegistration,
    request: ConnectionRequest,
    localId: string,
    sections: ConnectionDetailSection[],
  ): Promise<ConnectionDetailSection[]> =>
    Promise.all(
      sections.map(async section => {
        if (section.type !== 'settings') return section;
        const allowed = await permitted(connector, request, 'settings', localId, section.id);
        if (allowed === true) return section;
        return { ...section, fields: section.fields.map(field => (field.disabled ? field : { ...field, disabled: allowed })) };
      }),
    );

  /** The permissions as served: declared, defaults filled in. */
  const permissionsOf = (connector: ConnectorRegistration): ConnectionPermissions => ({
    ...DEFAULT_CONNECTION_PERMISSIONS,
    ...connector.connections.permissions,
  });

  const describe = async (connector: ConnectorRegistration, request: ConnectionRequest): Promise<ConnectorView> => {
    const description = await connector.connections.describe(request);
    const connect = await permitted(connector, request, 'connect', undefined);
    return {
      id: connector.id,
      ...description,
      // A method the request may not use is offered disabled, with why.
      methods: description.methods.map(method => (connect !== true && method.available === true ? { ...method, available: connect } : method)),
      permissions: permissionsOf(connector),
    };
  };
  const refOf = (view: ConnectorView): ConnectorRef => ({ id: view.id, name: view.name, icon: view.icon });
  const globalView = (ref: ConnectorRef, connection: ConnectorConnection): ConnectionView => ({
    ...connection,
    id: `${ref.id}:${connection.id}`,
    connector: ref,
  });

  /** Resolves `:id` to its connector, for a call that reads (`change` absent) or makes a change, which its permission gates. */
  const target = async (
    c: RouteContext,
    change?: ConnectionChange,
    section?: string,
  ): Promise<
    | { request: ConnectionRequest; connector: ConnectorRegistration; localId: string; copy: (typeof COPY)['en'] }
    | { response: Response }
  > => {
    const split = splitConnectionId(c.req.param('id') ?? '');
    const resolved = await resolve(c, split?.connectorId);
    if ('response' in resolved) return resolved;
    const copy = localize(COPY, resolved.language);
    const connector = split ? byId.get(split.connectorId) : undefined;
    if (!split || !connector) return { response: refuse(c, 404, { error: 'not_found', message: copy.notFound }) };
    if (change) {
      const allowed = await permitted(connector, resolved.request, change, split.localId, section);
      if (allowed !== true) return { response: refuse(c, 403, { error: 'forbidden', message: allowed.reason }) };
    }
    return { request: resolved.request, connector, localId: split.localId, copy };
  };

  const respond = <T>(c: RouteContext, outcome: ConnectionOutcome<T>, map: (value: T) => unknown) =>
    outcome.ok ? c.json(map(outcome.value) as never) : refuse(c, outcome.status, outcome.body);

  const connectResult = async (
    connector: ConnectorRegistration,
    request: ConnectionRequest,
    result: ConnectorConnectResult,
  ) =>
    result.type === 'authorize'
      ? result
      : {
          ...result,
          connection: globalView(refOf(await describe(connector, request)), await gateActions(connector, request, result.connection)),
        };

  return [
    registerApiRoute('/web/connections', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolve(c);
        if ('response' in resolved) return resolved.response;
        const { request, language } = resolved;
        const copy = localize(COPY, language);
        const results = await Promise.all(
          connectors.map(async connector => {
            if (!speaks(connector)) return { connections: [], failure: unsupportedFailure(connector, language) };
            let view: ConnectorView | undefined;
            try {
              view = await describe(connector, request);
              const listed = await connector.connections.list(request);
              const gated = await Promise.all(listed.map(connection => gateActions(connector, request, connection)));
              const ref = refOf(view);
              return { connections: gated.map(connection => globalView(ref, connection)), failure: undefined };
            } catch (error) {
              console.warn(`[factory] ${connector.id} connections could not be listed:`, error);
              const message = copy.listFailed(error instanceof Error ? error.message : String(error));
              // A connector that fails stays apart: named in `failures`, the others still served.
              return { connections: [], failure: { connector: view ? refOf(view) : unnamed(connector), message } };
            }
          }),
        );
        return c.json({
          contractVersion: CONNECTIONS_CONTRACT_VERSION,
          connections: results.flatMap(result => result.connections),
          failures: results.flatMap(result => (result.failure ? [result.failure] : [])),
          copy: { organizationWide: copy.organizationWide },
        });
      },
    }),
    // «Активність»: every connector's calls for the asking Factory, newest first (ADR-0035's first exception, now through the registry).
    registerApiRoute('/web/connections/activity', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolve(c);
        if ('response' in resolved) return resolved.response;
        const { request, language } = resolved;
        const copy = localize(COPY, language);
        const hoursParam = Number(c.req.query('hours') ?? 24);
        const hours = Number.isFinite(hoursParam) ? Math.min(Math.max(Math.trunc(hoursParam), 1), ACTIVITY_MAX_HOURS) : 24;
        const since = new Date(Date.now() - hours * 3_600_000);
        const body: ConnectionActivityResponse = { since: since.toISOString(), total: 0, errors: 0, calls: [], truncated: false, failures: [] };
        if (!request.factoryProjectId) return c.json(body);
        await Promise.all(
          connectors.filter(speaks).map(async connector => {
            if (!connector.connections.activity) return;
            let ref: ConnectorRef = unnamed(connector);
            try {
              ref = refOf(await describe(connector, request));
              const read = await connector.connections.activity(request, { since, limit: ACTIVITY_CALLS });
              body.total += read.total;
              body.errors += read.errors;
              body.truncated ||= read.truncated;
              body.calls.push(...read.calls.map(call => ({ ...call, connectionId: `${connector.id}:${call.connectionId}`, connector: ref })));
            } catch (error) {
              console.warn(`[factory] ${connector.id} activity could not be read:`, error);
              body.failures.push({ connector: ref, message: copy.listFailed(error instanceof Error ? error.message : String(error)) });
            }
          }),
        );
        body.calls = body.calls.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_CALLS);
        return c.json(body);
      },
    }),
    registerApiRoute('/web/connections/methods', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolve(c);
        if ('response' in resolved) return resolved.response;
        const copy = localize(COPY, resolved.language);
        const failures = connectors.filter(connector => !speaks(connector)).map(connector => unsupportedFailure(connector, resolved.language));
        const described = await Promise.all(
          connectors.filter(speaks).map(async connector => {
            try {
              return await describe(connector, resolved.request);
            } catch (error) {
              console.warn(`[factory] ${connector.id} could not describe itself:`, error);
              failures.push({ connector: unnamed(connector), message: copy.listFailed(error instanceof Error ? error.message : String(error)) });
              return undefined;
            }
          }),
        );
        return c.json({
          contractVersion: CONNECTIONS_CONTRACT_VERSION,
          connectors: described.filter((view): view is ConnectorView => view !== undefined),
          ...(failures.length > 0 ? { failures } : {}),
        });
      },
    }),
    registerApiRoute('/web/connections', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const parsed = connectRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        const resolved = await resolve(c, parsed.success ? parsed.data.connector : undefined);
        if ('response' in resolved) return resolved.response;
        const copy = localize(COPY, resolved.language);
        if (!parsed.success) return refuse(c, 400, { error: 'invalid_body', message: copy.invalidBody });
        const connector = byId.get(parsed.data.connector);
        if (!connector) return refuse(c, 404, { error: 'unknown_connector', message: copy.unknownConnector });
        const allowed = await permitted(connector, resolved.request, 'connect', undefined);
        if (allowed !== true) return refuse(c, 403, { error: 'forbidden', message: allowed.reason });
        const outcome = await connector.connections.connect(resolved.request, parsed.data.method, parsed.data.input);
        if (!outcome.ok) return refuse(c, outcome.status, outcome.body);
        return c.json(await connectResult(connector, resolved.request, outcome.value));
      },
    }),
    registerApiRoute('/web/connections/authorizations/:authId', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const connectorId = c.req.query('connector') ?? '';
        const resolved = await resolve(c, connectorId);
        if ('response' in resolved) return resolved.response;
        const copy = localize(COPY, resolved.language);
        const connector = byId.get(connectorId);
        if (!connector) return refuse(c, 404, { error: 'unknown_connector', message: copy.unknownConnector });
        if (!connector.connections.getAuthStatus) return refuse(c, 409, { error: 'unsupported', message: copy.unsupported });
        const status = await connector.connections.getAuthStatus(resolved.request, c.req.param('authId'));
        if (!status) return refuse(c, 404, { error: 'not_found', message: copy.notFound });
        return c.json(typeof status === 'string' ? { status } : status);
      },
    }),
    registerApiRoute('/web/connections/:id/reconnect', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const found = await target(c, 'reconnect');
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        const parsed = reconnectRequestSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
        if (!parsed.success) return refuse(c, 400, { error: 'invalid_body', message: copy.invalidBody });
        if (!connector.connections.reconnect) return refuse(c, 409, { error: 'unsupported', message: copy.unsupported });
        const outcome = await connector.connections.reconnect(request, localId, parsed.data.input);
        if (!outcome.ok) return refuse(c, outcome.status, outcome.body);
        return c.json(await connectResult(connector, request, outcome.value));
      },
    }),
    registerApiRoute('/web/connections/:id', {
      method: 'PATCH',
      requiresAuth: false,
      handler: async c => {
        const found = await target(c, 'rename');
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        const parsed = renameConnectionSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) return refuse(c, 400, { error: 'invalid_body', message: copy.invalidBody });
        if (!connector.connections.rename) return refuse(c, 409, { error: 'unsupported', message: copy.unsupported });
        return respond(c, await connector.connections.rename(request, localId, parsed.data.name.trim()), value => value);
      },
    }),
    registerApiRoute('/web/connections/:id/impact', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const found = await target(c);
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        if (!connector.connections.removalImpact) return refuse(c, 409, { error: 'unsupported', message: copy.unsupported });
        const impact = await connector.connections.removalImpact(request, localId);
        return impact ? c.json(impact) : refuse(c, 404, { error: 'not_found', message: copy.notFound });
      },
    }),
    registerApiRoute('/web/connections/:id', {
      method: 'DELETE',
      requiresAuth: false,
      handler: async c => {
        const found = await target(c, 'remove');
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        if (!connector.connections.remove) return refuse(c, 409, { error: 'unsupported', message: copy.unsupported });
        const outcome = await connector.connections.remove(request, localId, { confirm: c.req.query('confirm') === '1' });
        return respond(c, outcome, value => ({ removed: true, message: value.message }));
      },
    }),
    registerApiRoute('/web/connections/:id/unlink', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const found = await target(c, 'unlink');
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        if (!connector.connections.unlink) return refuse(c, 409, { error: 'unsupported', message: copy.unsupported });
        return respond(c, await connector.connections.unlink(request, localId), value => value);
      },
    }),
    registerApiRoute('/web/connections/:id/settings', {
      method: 'PATCH',
      requiresAuth: false,
      handler: async c => {
        const body = updateConnectionSettingsSchema.safeParse(await c.req.json().catch(() => undefined));
        const found = await target(c, 'settings', body.success ? body.data.section : undefined);
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        const parsed = body;
        if (!parsed.success) return refuse(c, 400, { error: 'invalid_body', message: copy.invalidBody });
        if (!connector.connections.updateSettings) return refuse(c, 409, { error: 'unsupported', message: copy.unsupported });
        const outcome = await connector.connections.updateSettings(request, localId, parsed.data.section, parsed.data.values);
        return respond(c, outcome, value => value);
      },
    }),
    registerApiRoute('/web/connections/:id/detail', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const found = await target(c);
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        const sections = connector.connections.detail ? await connector.connections.detail(request, localId) : [];
        return sections ? c.json({ sections: await gateSections(connector, request, localId, sections) }) : refuse(c, 404, { error: 'not_found', message: copy.notFound });
      },
    }),
  ];
}

/** What each route that changes something needs (ADR-0045, `@factory/access`). */
const ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'POST /web/connections': 'factory.configure',
  'POST /web/connections/:id/reconnect': 'factory.configure',
  'PATCH /web/connections/:id': 'factory.configure',
  'DELETE /web/connections/:id': 'factory.configure',
  'POST /web/connections/:id/unlink': 'factory.configure',
  'PATCH /web/connections/:id/settings': 'factory.configure',
};
