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
  connectRequestSchema,
  reconnectRequestSchema,
  renameConnectionSchema,
  updateConnectionSettingsSchema,
} from '@factory/contracts';
import type {
  AuthFlowStatus,
  ConnectionDetailSection,
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

/** A connector as it describes itself; the registry adds its id. */
export type ConnectorDescription = Omit<ConnectorView, 'id'>;

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
   * The connector decides who may connect and change its connections (each member manages their own
   * accounts: a harness's sign-ins). Unset, the registry lets only organization admins change them.
   */
  readonly memberManaged?: boolean;
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
   * Saves a `settings` section of the detail page. Not gated by the registry: the connector decides
   * who may change what (a field a member may not change is `disabled` with a reason).
   */
  updateSettings?(
    request: ConnectionRequest,
    id: string,
    section: string,
    values: ConnectionSettingsValues,
  ): Promise<ConnectionOutcome<{ message: string }>>;
  /** The detail page's sections; null when it does not exist. */
  detail?(request: ConnectionRequest, id: string): Promise<ConnectionDetailSection[] | null>;
}

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
  notFound: string;
  unknownConnector: string;
  invalidBody: string;
  listFailed: (error: string) => string;
  organizationWide: string;
  unsupported: string;
}> = {
  en: {
    unauthorized: 'Sign in to see connections.',
    organizationRequired: 'Connections belong to an organization. Personal accounts cannot connect.',
    adminOnly: 'Only organization admins can change connections.',
    notFound: 'This connection no longer exists.',
    unknownConnector: 'This integration is not available on this server.',
    invalidBody: 'The request is not what this action takes.',
    listFailed: error => `Could not read the connections: ${error}`,
    organizationWide: 'The whole organization',
    unsupported: 'This connection cannot do that.',
  },
  uk: {
    unauthorized: 'Увійдіть, щоб бачити підключення.',
    organizationRequired: 'Підключення належать організації. Особистий акаунт не може підключати.',
    adminOnly: 'Змінювати підключення можуть лише адміністратори організації.',
    notFound: 'Цього підключення вже немає.',
    unknownConnector: 'Ця інтеграція недоступна на цьому сервері.',
    invalidBody: 'Запит не такий, як ця дія приймає.',
    listFailed: error => `Не вдалося прочитати підключення: ${error}`,
    organizationWide: 'Уся організація',
    unsupported: 'Це підключення так не вміє.',
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
 * refused), readable by members, changed by organization admins only (unless the connector is
 * `memberManaged` and decides itself); every refusal and every
 * string is in the request's language.
 */
export function buildConnectionRoutes(options: ConnectionRoutesOptions): ApiRoute[] {
  const { auth, connectors, emitAudit } = options;
  const byId = new Map(connectors.map(connector => [connector.id, connector]));

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
    const admin = !auth.enabled() || (await auth.isOrganizationAdmin(c, orgId));
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

  const describe = async (connector: ConnectorRegistration, request: ConnectionRequest): Promise<ConnectorView> => ({
    id: connector.id,
    ...(await connector.connections.describe(request)),
  });
  const refOf = (view: ConnectorView): ConnectorRef => ({ id: view.id, name: view.name, icon: view.icon });
  const globalView = (ref: ConnectorRef, connection: ConnectorConnection): ConnectionView => ({
    ...connection,
    id: `${ref.id}:${connection.id}`,
    connector: ref,
  });

  /** Resolves `:id` to its connector, for a call that reads (`write: false`) or changes it. */
  const target = async (
    c: RouteContext,
    write: boolean,
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
    if (write && !resolved.request.admin && !connector.connections.memberManaged) return { response: refuse(c, 403, { error: 'forbidden', message: copy.adminOnly }) };
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
      : { ...result, connection: globalView(refOf(await describe(connector, request)), result.connection) };

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
            const view = await describe(connector, request);
            try {
              const listed = await connector.connections.list(request);
              return { connections: listed.map(connection => globalView(refOf(view), connection)), failure: undefined };
            } catch (error) {
              console.warn(`[factory] ${connector.id} connections could not be listed:`, error);
              const message = copy.listFailed(error instanceof Error ? error.message : String(error));
              return { connections: [], failure: { connector: refOf(view), message } };
            }
          }),
        );
        return c.json({
          connections: results.flatMap(result => result.connections),
          failures: results.flatMap(result => (result.failure ? [result.failure] : [])),
          copy: { organizationWide: copy.organizationWide },
        });
      },
    }),
    registerApiRoute('/web/connections/methods', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolve(c);
        if ('response' in resolved) return resolved.response;
        return c.json({ connectors: await Promise.all(connectors.map(connector => describe(connector, resolved.request))) });
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
        if (!resolved.request.admin && !connector.connections.memberManaged) {
          return refuse(c, 403, { error: 'forbidden', message: copy.adminOnly });
        }
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
        const found = await target(c, true);
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
        const found = await target(c, true);
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
        const found = await target(c, false);
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
        const found = await target(c, true);
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
        const found = await target(c, true);
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
        const found = await target(c, false);
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        const parsed = updateConnectionSettingsSchema.safeParse(await c.req.json().catch(() => undefined));
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
        const found = await target(c, false);
        if ('response' in found) return found.response;
        const { request, connector, localId, copy } = found;
        const sections = connector.connections.detail ? await connector.connections.detail(request, localId) : [];
        return sections ? c.json({ sections }) : refuse(c, 404, { error: 'not_found', message: copy.notFound });
      },
    }),
  ];
}
