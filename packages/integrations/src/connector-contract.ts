/**
 * The connector conformance kit (ADR-0035, ADR-0036): one vitest suite every connector runs against
 * the real registry (`buildConnectionRoutes`), so what the UI relies on holds for each of them —
 * descriptor shapes, global ids, actions as `true | { reason }`, removal impact before confirmation,
 * rename, the authorize flow, copy in both languages, declared permissions enforced, failure
 * isolation, the contract version, and no secret in any response.
 *
 *   describeConnectorContract('GitHub', async () => ({ registration, orgId, admin, member, secrets, … }));
 *
 * The fixture seeds whatever the connector needs (storage, a fake provider) and names the users: an
 * organization admin and a plain member of `orgId`. Optional parts (`connect`, `authorize`, `rename`,
 * `remove`) run only when given.
 */

import type { ApiRoute } from '@mastra/core/server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { CONNECTION_LANGUAGES, CONNECTIONS_CONTRACT_VERSION, contractMajor } from '@factory/contracts';
import type { ConnectionPermission, ConnectionView, ConnectorView } from '@factory/contracts';
import { fakeRouteAuth } from '@factory/http/testing';

import { buildConnectionRoutes, connectionOk } from './connections.ts';
import type { ConnectorRegistration, IntegrationConnections } from './connections.ts';

export interface ConnectorContractFixture {
  /** The connector under test, as the registry registers it. */
  registration: ConnectorRegistration;
  orgId: string;
  /** An organization admin of `orgId`, and a member who is not one. */
  admin: string;
  member: string;
  /** The Factory the page asks for (Factory-scoped connections are listed for it). */
  factoryProjectId?: string;
  /** Strings that must never appear in any response (tokens, keys, private keys). */
  secrets?: string[];
  /** At least one connection exists after setup (the list, impact, rename and permission checks need one). */
  expectsConnections?: boolean;
  /** A connect the admin makes that succeeds (`connected` or `authorize`). */
  connect?: { method: string; input: Record<string, string> };
  /** A connect whose answer is an `authorize` with an `authId`, and how the test finishes it on the provider's side. */
  authorize?: { as?: 'admin' | 'member'; method: string; input?: Record<string, string>; finish(authId: string): Promise<void> };
  /** The connection (global id, or `true`: the first listed) the admin may rename; renaming is checked when given. */
  rename?: string | true;
  /** The connection (global id, or `true`: the first listed) the admin removes at the end, confirming when its impact asks. */
  remove?: string | true;
  /** Seeds through the routes before each test (a connect the admin makes); its answers count for the secret scan too. */
  seed?(api: { send(userId: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> }): Promise<void>;
}

type Sent = { status: number; body: any };

function mount(routes: ApiRoute[], userId: string, orgId: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, { id: userId, organizationId: orgId } as never);
    await next();
  });
  for (const route of routes) if ('handler' in route) hono.on(route.method, route.path, route.handler as never);
  return hono;
}

/** Every string in a payload, with where it is, for the copy checks. */
function strings(value: unknown, path = '$'): Array<{ path: string; value: string }> {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

/** The strings the person reads in a connector's descriptor: names, labels, reasons — each must say something. */
function connectorCopy(view: ConnectorView): string[] {
  return [
    view.name,
    ...(view.description !== undefined ? [view.description] : []),
    ...view.provides.map(item => item.label),
    ...view.methods.flatMap(method => [
      method.label,
      ...(method.description !== undefined ? [method.description] : []),
      ...(method.available === true ? [] : [method.available.reason]),
      ...(method.fields ?? []).map(field => field.displayName ?? field.name),
    ]),
  ];
}

function connectionCopy(view: ConnectionView): string[] {
  return [
    view.label,
    view.state.label,
    ...view.provides.map(item => item.label),
    ...Object.values(view.actions).flatMap(action =>
      action === true || action === undefined ? [] : 'reason' in action ? [action.reason] : 'label' in action ? [action.label] : [action.method.label],
    ),
  ];
}

function expectAction(name: string, action: unknown) {
  if (action === undefined || action === true) return;
  expect(action, `action ${name}`).toBeTypeOf('object');
  const value = action as Record<string, unknown>;
  if ('reason' in value) expect(String(value.reason).trim(), `${name}.reason`).not.toBe('');
  else if ('method' in value) expect((value.method as { id?: unknown }).id, `${name}.method.id`).toBeTypeOf('string');
  else expect(value, name).toMatchObject({ url: expect.any(String), label: expect.any(String) });
}

const isAdminOnly = (permission: ConnectionPermission | undefined) => permission === undefined || permission === 'admin';

/**
 * Registers the conformance suite for one connector. `setup` runs before each test with fresh state.
 */
export function describeConnectorContract(label: string, setup: () => Promise<ConnectorContractFixture>): void {
  describe(`${label}: connector contract`, () => {
    const harness = async (extra: ConnectorRegistration[] = []) => {
      const fixture = await setup();
      const responses: unknown[] = [];
      const routes = buildConnectionRoutes({
        auth: fakeRouteAuth({ isAdmin: async (_org, userId) => userId === fixture.admin }),
        connectors: [fixture.registration, ...extra],
      });
      const send = async (userId: string, method: string, path: string, body?: unknown, language = 'en'): Promise<Sent> => {
        const response = await mount(routes, userId, fixture.orgId).request(path, {
          method,
          headers: { 'accept-language': language, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const parsed = (await response.json().catch(() => null)) as unknown;
        responses.push(parsed);
        return { status: response.status, body: parsed };
      };
      await fixture.seed?.({ send });
      const query = fixture.factoryProjectId ? `?factoryProjectId=${encodeURIComponent(fixture.factoryProjectId)}` : '';
      const list = async (userId = fixture.admin, language = 'en') =>
        (await send(userId, 'GET', `/web/connections${query}`, undefined, language)).body.connections.filter(
          (connection: ConnectionView) => connection.connector.id === fixture.registration.id,
        ) as ConnectionView[];
      const methods = async (userId = fixture.admin, language = 'en') =>
        (await send(userId, 'GET', `/web/connections/methods${query}`, undefined, language)).body.connectors.find(
          (connector: ConnectorView) => connector.id === fixture.registration.id,
        ) as ConnectorView | undefined;
      const path = (id: string, suffix = '') => `/web/connections/${encodeURIComponent(id)}${suffix}${query ? (suffix.includes('?') ? `&${query.slice(1)}` : query) : ''}`;
      /** No response so far carried a fixture secret. */
      const expectNoSecrets = () => {
        const text = JSON.stringify(responses);
        for (const secret of fixture.secrets ?? []) expect(text.includes(secret), 'a response carried a secret').toBe(false);
      };
      return { fixture, send, list, methods, path, expectNoSecrets };
    };

    it('implements a contract version the registry speaks', async () => {
      const { fixture } = await harness();
      const version = fixture.registration.connections.contractVersion ?? CONNECTIONS_CONTRACT_VERSION;
      expect(contractMajor(version)).toBe(contractMajor(CONNECTIONS_CONTRACT_VERSION));
    });

    it('describes itself: name, logo key, category, methods, resolved permissions; every string set in each language', async () => {
      const { fixture, methods, expectNoSecrets } = await harness();
      for (const language of CONNECTION_LANGUAGES) {
        const view = await methods(fixture.admin, language);
        expect(view, `described in ${language}`).toBeDefined();
        expect(view!.name.trim()).not.toBe('');
        expect(view!.icon.trim()).not.toBe('');
        expect(['tools', 'sources', 'agents']).toContain(view!.category);
        expect(view!.capabilities).toMatchObject({ multipleConnectionsPerToolkit: expect.any(Boolean) });
        expect(view!.permissions).toMatchObject({ connect: expect.anything(), remove: expect.anything(), settings: expect.anything() });
        for (const method of view!.methods) {
          expect(method.id.trim()).not.toBe('');
          expect(['oauth', 'apiKey']).toContain(method.authKind);
          if (method.available !== true) expect(method.available.reason.trim()).not.toBe('');
        }
        for (const text of connectorCopy(view!)) expect(text.trim(), `copy in ${language}`).not.toBe('');
      }
      expectNoSecrets();
    });

    it('lists connections under global ids with actions as true | { reason }, every string set in each language', async () => {
      const { fixture, list, expectNoSecrets } = await harness();
      for (const language of CONNECTION_LANGUAGES) {
        const connections = await list(fixture.admin, language);
        if (fixture.expectsConnections) expect(connections.length, 'connections listed').toBeGreaterThan(0);
        for (const connection of connections) {
          expect(connection.id.startsWith(`${fixture.registration.id}:`), connection.id).toBe(true);
          expect(connection.connector).toMatchObject({ id: fixture.registration.id, name: expect.any(String), icon: expect.any(String) });
          expect(['active', 'needs_reauth']).toContain(connection.status);
          expect(['ok', 'warning', 'error', 'idle']).toContain(connection.state.tone);
          expect(['organization', 'factory']).toContain(connection.scope);
          for (const [name, action] of Object.entries(connection.actions)) expectAction(name, action);
          for (const text of connectionCopy(connection)) expect(text.trim(), `copy of ${connection.id} in ${language}`).not.toBe('');
        }
      }
      expectNoSecrets();
    });

    it('serves each connection’s detail sections, and its removal impact before any removal', async () => {
      const { fixture, list, send, path, expectNoSecrets } = await harness();
      for (const connection of await list()) {
        const detail = await send(fixture.admin, 'GET', path(connection.id, '/detail'));
        expect(detail.status, `detail of ${connection.id}`).toBe(200);
        for (const section of detail.body.sections) expect(['settings', 'facts', 'table', 'custom', 'notice']).toContain(section.type);
        if (connection.actions.remove === true) {
          const impact = await send(fixture.admin, 'GET', path(connection.id, '/impact'));
          expect(impact.status, `impact of ${connection.id}`).toBe(200);
          expect(impact.body).toMatchObject({ title: expect.any(String), confirmLabel: expect.any(String), requiresConfirm: expect.any(Boolean) });
          for (const item of impact.body.items) expect(['moves', 'unlinks', 'deleted', 'stops']).toContain(item.outcome);
        }
      }
      expectNoSecrets();
    });

    it('enforces its declared permissions for a member, in routes and in what it serves', async () => {
      const { fixture, list, methods, send, path } = await harness();
      const declared = fixture.registration.connections.permissions ?? {};
      const asMember = await methods(fixture.member);
      if (isAdminOnly(declared.connect)) {
        for (const method of asMember?.methods ?? []) expect(method.available, `method ${method.id} for a member`).not.toBe(true);
        const method = asMember?.methods[0]?.id ?? 'any';
        const refused = await send(fixture.member, 'POST', `/web/connections`, { connector: fixture.registration.id, method, input: {} });
        expect(refused.status).toBe(403);
      }
      for (const connection of await list(fixture.member)) {
        for (const change of ['rename', 'remove', 'unlink'] as const) {
          if (!isAdminOnly(declared[change]) || connection.actions[change] === undefined) continue;
          expect(connection.actions[change], `${change} of ${connection.id} for a member`).toMatchObject({ reason: expect.any(String) });
        }
        if (isAdminOnly(declared.remove)) expect((await send(fixture.member, 'DELETE', path(connection.id, '?confirm=1'))).status).toBe(403);
        if (isAdminOnly(declared.rename)) expect((await send(fixture.member, 'PATCH', path(connection.id), { name: 'x' })).status).toBe(403);
      }
    });

    it('keeps serving when another connector fails', async () => {
      const broken: IntegrationConnections = {
        describe: () => ({ name: 'Broken', icon: 'broken', category: 'tools', provides: [], capabilities: { multipleConnectionsPerToolkit: false, batchConnectionStatus: false, reauthorizeReusesConnectionId: false }, methods: [] }),
        list: async () => {
          throw new Error('down');
        },
        connect: async () => connectionOk({ type: 'authorize' }),
      };
      const { fixture, send } = await harness([{ id: 'zz-broken-sibling', connections: broken }]);
      const listed = await send(fixture.admin, 'GET', `/web/connections${fixture.factoryProjectId ? `?factoryProjectId=${fixture.factoryProjectId}` : ''}`);
      expect(listed.status).toBe(200);
      expect(listed.body.failures.map((failure: { connector: { id: string } }) => failure.connector.id)).toContain('zz-broken-sibling');
      expect(listed.body.failures.map((failure: { connector: { id: string } }) => failure.connector.id)).not.toContain(fixture.registration.id);
    });

    it('connects, renames and removes as declared, and never answers with a secret', async () => {
      const { fixture, send, path, list, expectNoSecrets } = await harness();
      if (fixture.connect) {
        const connected = await send(fixture.admin, 'POST', '/web/connections', { connector: fixture.registration.id, ...fixture.connect });
        expect(connected.status, JSON.stringify(connected.body)).toBe(200);
        expect(['connected', 'authorize']).toContain(connected.body.type);
        if (connected.body.type === 'connected') {
          expect(connected.body.connection.id.startsWith(`${fixture.registration.id}:`)).toBe(true);
          expect(connected.body.title.trim()).not.toBe('');
        }
      }
      const first = async () => (await list())[0]?.id ?? '';
      if (fixture.rename) {
        const target = fixture.rename === true ? await first() : fixture.rename;
        const renamed = await send(fixture.admin, 'PATCH', path(target), { name: 'Contract name' });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        expect(renamed.body.name).toBe('Contract name');
      }
      if (fixture.remove) {
        const target = fixture.remove === true ? await first() : fixture.remove;
        const impact = await send(fixture.admin, 'GET', path(target, '/impact'));
        if (impact.body.requiresConfirm) {
          const refused = await send(fixture.admin, 'DELETE', path(target));
          expect(refused.status).toBe(409);
          expect(refused.body.impact).toMatchObject({ title: expect.any(String) });
        }
        const removed = await send(fixture.admin, 'DELETE', path(target, '?confirm=1'));
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect(removed.body).toMatchObject({ removed: true, message: expect.any(String) });
        expect((await list()).map(connection => connection.id)).not.toContain(target);
      }
      expectNoSecrets();
    });

    it('follows an authorize flow by its authId to the end', async () => {
      const { fixture, send } = await harness();
      if (!fixture.authorize) return;
      const user = fixture.authorize.as === 'member' ? fixture.member : fixture.admin;
      const started = await send(user, 'POST', '/web/connections', {
        connector: fixture.registration.id,
        method: fixture.authorize.method,
        input: fixture.authorize.input ?? {},
      });
      expect(started.body).toMatchObject({ type: 'authorize', authId: expect.any(String) });
      const status = () => send(user, 'GET', `/web/connections/authorizations/${encodeURIComponent(started.body.authId)}?connector=${fixture.registration.id}`);
      expect((await status()).body.status).toBe('pending');
      await fixture.authorize.finish(started.body.authId);
      expect((await status()).body.status).toBe('completed');
    });

    it('has no empty string anywhere it answers in either language', async () => {
      const { fixture, send } = await harness();
      for (const language of CONNECTION_LANGUAGES) {
        const query = fixture.factoryProjectId ? `?factoryProjectId=${fixture.factoryProjectId}` : '';
        for (const url of [`/web/connections${query}`, `/web/connections/methods${query}`]) {
          const { body } = await send(fixture.admin, 'GET', url, undefined, language);
          const own = url.includes('methods')
            ? body.connectors.filter((connector: ConnectorView) => connector.id === fixture.registration.id)
            : body.connections.filter((connection: ConnectionView) => connection.connector.id === fixture.registration.id);
          // Values that are copy (labels, names, reasons, messages, titles) are never empty.
          for (const entry of strings(own)) {
            if (/\.(label|name|reason|message|title|displayName)$/.test(entry.path)) expect(entry.value.trim(), `${entry.path} in ${language}`).not.toBe('');
          }
        }
      }
    });
  });
}
