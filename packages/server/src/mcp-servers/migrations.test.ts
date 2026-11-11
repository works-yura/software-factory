import { describe, expect, it } from 'vitest';

import { prepareMcpServer } from './launch.ts';
import { presetToCatalogLaunch } from './migrations.ts';

const noSecrets = { env: {}, headers: {}, files: {} };

describe('presetToCatalogLaunch', () => {
  it('moves a Firestore preset to the catalog, keeping its project and pasted key so it still runs', async () => {
    const moved = presetToCatalogLaunch({
      launch: { transport: 'stdio', preset: 'toolbox-firestore', args: [], env: { FIRESTORE_PROJECT: 'syncta-57c6a', OTHER: 'x' } },
      secrets: { env: {}, headers: {}, files: { GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account"}' } },
    });
    expect(moved).toEqual({
      launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' }, credentials: {} },
      secrets: { env: {}, headers: {}, files: { GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account"}' } },
    });
    const prepared = await prepareMcpServer(moved!.launch, moved!.secrets);
    expect((prepared.definition as { env: Record<string, string> }).env.FIRESTORE_PROJECT).toBe('syncta-57c6a');
    await prepared.cleanup();
  });

  it('moves an own tools.yaml preset, renaming its file input', () => {
    expect(
      presetToCatalogLaunch({
        launch: { transport: 'stdio', preset: 'toolbox', args: [], env: {} },
        secrets: { env: {}, headers: {}, files: { TOOLBOX_TOOLS_FILE: 'sources: {}' } },
      }),
    ).toEqual({
      launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'tools-file', inputs: {}, credentials: {} },
      secrets: { env: {}, headers: {}, files: { tools_file: 'sources: {}' } },
    });
  });

  it('leaves local commands, addresses and catalog launches alone, and refuses an unknown preset', () => {
    expect(presetToCatalogLaunch({ launch: { transport: 'stdio', command: 'x', args: [], env: {} }, secrets: noSecrets })).toBeNull();
    expect(presetToCatalogLaunch({ launch: { transport: 'http', url: 'https://x.test', headers: {} }, secrets: noSecrets })).toBeNull();
    expect(
      presetToCatalogLaunch({
        launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs: {}, credentials: {} },
        secrets: noSecrets,
      }),
    ).toBeNull();
    expect(() =>
      presetToCatalogLaunch({ launch: { transport: 'stdio', preset: 'mystery', args: [], env: {} }, secrets: noSecrets }),
    ).toThrow(/mystery/);
  });
});
