import { LibSQLFactoryStorage } from '@mastra/libsql';
import { registerApiRoute } from '@mastra/core/server';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { FACTORY_HARNESSES, createFactorySecretEncryption } from '@factory/store';
import { HARNESSES } from '@factory/contracts';
import type { HarnessDescriptor } from '@factory/harness/descriptor';
import type { HarnessUsage } from '@factory/harness/usage';
import { codexStubModels } from '@factory/harness/models/registry.testFixtures';
import { mountApiRoutes } from '@factory/http/testing';

import { MastraFactory } from '../factory.ts';
import type { RunningTurnHarness, TurnHarnessModule } from './module.ts';
import { SERVER_HARNESS_MODULES } from './registry.ts';

vi.setConfig({ testTimeout: 30_000 });

const secretEncryption = createFactorySecretEncryption({ primary: { id: 'test', key: Buffer.alloc(32, 7) } });

const ROBO: HarnessDescriptor = {
  id: 'robo',
  label: 'Robo Agent',
  icon: 'robo',
  modelScope: 'factory',
  supports: {
    goal: false,
    thinkingLevel: false,
    sessionPermissions: false,
    imageAttachments: false,
    memory: false,
    knowledge: false,
    sandboxRecreate: false,
    sessionlessChat: false,
  },
  setup: { modelProvider: false },
};

/**
 * A harness nobody wrote server or API code for: one module, its config under its own key. What it
 * gives the server is the least a turn harness can (an empty session store, a stub catalog).
 */
function roboModule(seen: { usageFacet?: HarnessUsage; config?: unknown }): TurnHarnessModule<{ greeting: string }, 'robo'> {
  const usage: HarnessUsage = { harnessId: 'robo', displayName: 'Robo Agent', accountProvider: 'robo-accounts' };
  return {
    kind: 'turn',
    descriptor: ROBO,
    configKey: 'robo',
    featureFlags: ['roboReady'],
    prepare(config) {
      seen.config = config;
      return {
        usage,
        create(host): RunningTurnHarness {
          const models = { ...codexStubModels(new Set()), instanceId: 'robo', harnessId: 'robo', displayName: 'Robo Agent' };
          const harness = {
            getSession: async () => undefined,
            createSession: async () => {
              throw new Error('Robo keeps no sessions in this test.');
            },
            releaseSession: async () => {},
            deleteSession: async () => {},
          };
          return {
            descriptor: ROBO,
            harness,
            route: { harness: harness as never, owns: async () => false },
            models,
            parked: { parked: async () => [], get: async () => undefined },
            removeSessionFiles: async () => {},
            resolveChatSession: async () => undefined,
            modelSelection: () => undefined,
            checkout: host.checkout,
            customCheckout: false,
            userSessions: { get: async () => undefined, start: async () => {}, harnesses: ['robo'] },
            available: () => true,
            joinsSessionRouting: false,
            asksMidCall: false,
            api: {
              features: { roboReady: true },
              connectors: ({ deps }) => {
                seen.usageFacet = deps.usage?.harnesses.forHarness('robo');
                return [];
              },
              routes: () => [
                registerApiRoute('/web/robo/ping', {
                  method: 'GET',
                  requiresAuth: false,
                  handler: async c => c.json({ pong: (config as { greeting: string }).greeting }),
                }),
              ],
            },
          };
        },
      };
    },
  };
}

describe('harness modules (ADR-0044)', () => {
  it('a harness module registered with the server shows in its features, models, usage and routes', async () => {
    const seen: { usageFacet?: HarnessUsage; config?: unknown } = {};
    const factory = new MastraFactory({
      storage: new LibSQLFactoryStorage({ id: 'harness-modules', url: ':memory:' }),
      auth: null,
      mcp: false,
      secretEncryption,
      harnessModules: [...SERVER_HARNESS_MODULES, roboModule(seen)],
      harnessConfigs: { robo: { greeting: 'beep' } },
    });
    const args = await factory.prepare();
    const app = new Hono();
    mountApiRoutes(app as never, args.server!.apiRoutes! as never);

    expect(seen.config).toEqual({ greeting: 'beep' });

    // Features: its descriptor among the running harnesses, its own flag on.
    const features = (await (await app.request('/web/config/features')).json()) as { harnesses: HarnessDescriptor[]; roboReady?: boolean };
    expect(features.harnesses.map(harness => harness.id)).toEqual(['mastra', 'robo']);
    expect(features.harnesses.at(-1)).toMatchObject({ label: 'Robo Agent' });
    expect(features.roboReady).toBe(true);
    // The built-in harnesses the config leaves out are off, their flags false.
    expect(features).toMatchObject({ claudeCode: false, codex: false, opencodeLocalSessions: false });

    // Models: its instance beside Mastra's.
    const models = (await (await app.request('/web/config/models')).json()) as { instances?: Array<{ instanceId: string; harnessId: string }> };
    expect(models.instances?.map(instance => instance.instanceId)).toContain('robo');

    // Usage: its facet is in the server's usage registry, as the API reads it.
    expect(seen.usageFacet).toMatchObject({ harnessId: 'robo', accountProvider: 'robo-accounts' });

    // Routes: its own route is served.
    const ping = await app.request('/web/robo/ping');
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toEqual({ pong: 'beep' });

    await factory.shutdown?.();
  });

  it('the built-in registry matches what the browser and the stored Factories know', () => {
    const ids = SERVER_HARNESS_MODULES.map(module => module.descriptor.id);
    // The browser's descriptors (`@factory/contracts`) and the stored harness ids (`@factory/store`).
    expect(ids).toEqual(HARNESSES.map(harness => harness.id));
    expect(ids).toEqual([...FACTORY_HARNESSES]);
    expect(SERVER_HARNESS_MODULES.map(module => module.descriptor)).toEqual([...HARNESSES]);
  });
});
