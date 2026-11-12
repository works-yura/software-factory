import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { fakeRouteAuth } from '@factory/http/testing';

import { buildConnectionRoutes } from './connections.ts';
import { connectorPackageSpecs, loadConnectorPackages } from './connector-packages.ts';
import { describeConnectorContract } from './connector-contract.ts';
import { mountApiRoutes } from './testing.ts';

const EXAMPLE = fileURLToPath(new URL('../examples/connector-example/index.ts', import.meta.url));

describe('connector packages loaded at boot', () => {
  it('reads FACTORY_CONNECTOR_PACKAGES as a comma-separated list', () => {
    expect(connectorPackageSpecs(' @acme/connector , ./local.ts,, ')).toEqual(['@acme/connector', './local.ts']);
    expect(connectorPackageSpecs(undefined)).toEqual([]);
  });

  it('loads the example package by its path, checked against the contract', async () => {
    const loaded = await loadConnectorPackages([EXAMPLE]);
    expect(loaded.failures).toEqual([]);
    expect(loaded.registrations.map(registration => registration.id)).toEqual(['notes-cloud']);
  });

  it('isolates each package that does not load: the server starts and Підключення names them', async () => {
    const modules: Record<string, unknown> = {
      bad: { nothing: true },
      future: { connector: { id: 'future', contractVersion: '9.0.0', create: () => ({}) } },
      taken: { connector: { id: 'github', contractVersion: '1.0.0', create: () => ({}) } },
      throws: { connector: { id: 'throws', contractVersion: '1.0.0', create: () => { throw new Error('no config'); } } },
    };
    const loaded = await loadConnectorPackages(['missing', 'bad', 'future', 'taken', 'throws', EXAMPLE], {
      reservedIds: ['github'],
      import: async spec => {
        if (spec === EXAMPLE) return import(spec);
        if (!(spec in modules)) throw new Error(`Cannot find module '${spec}'`);
        return modules[spec];
      },
    });
    expect(loaded.failures.map(failure => [failure.spec, failure.id])).toEqual([
      ['missing', 'missing'],
      ['bad', 'bad'],
      ['future', 'future'],
      ['taken', 'github-package'],
      ['throws', 'throws'],
    ]);
    expect(loaded.failures.find(failure => failure.spec === 'future')!.message).toContain('9.0.0');

    const routes = buildConnectionRoutes({ auth: fakeRouteAuth(), connectors: loaded.registrations });
    const hono = new Hono();
    hono.use('*', async (c, next) => {
      c.set('factoryAuthUser' as never, { id: 'u', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(hono, routes);
    const methods = (await (await hono.request('/web/connections/methods')).json()) as any;
    expect(methods.connectors.map((connector: { id: string }) => connector.id)).toEqual(['notes-cloud']);
    expect(methods.failures.map((failure: { connector: { id: string } }) => failure.connector.id)).toEqual(['missing', 'bad', 'future', 'github-package', 'throws']);
  });
});

// The example package passes the same conformance suite as every first-party connector.
describeConnectorContract('Notes Cloud (example package)', async () => {
  const { registrations } = await loadConnectorPackages([EXAMPLE]);
  return {
    registration: registrations[0]!,
    orgId: 'org-1',
    admin: 'admin',
    member: 'member',
    secrets: ['notes_contract_secret_key', 'notes_seeded_key_42'],
    connect: { method: 'key', input: { key: 'notes_contract_secret_key' } },
    seed: async ({ send }) => {
      const connected = await send('admin', 'POST', '/web/connections', { connector: 'notes-cloud', method: 'key', input: { key: 'notes_seeded_key_42' } });
      if (connected.status !== 200) throw new Error(`seed failed: ${JSON.stringify(connected.body)}`);
    },
    expectsConnections: true,
    rename: true,
    remove: true,
  };
});
