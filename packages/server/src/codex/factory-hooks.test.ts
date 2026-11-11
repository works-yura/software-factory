import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { codexGeneratedImageKeeper, codexLiveWebForProductCards } from './factory-hooks.ts';

const where = { orgId: 'org-a', factoryProjectId: 'factory-a', sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' };

async function bytes(body: unknown): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

describe('Codex Factory hooks', () => {
  it('reads the web live only for a session working a Product card', async () => {
    const live = codexLiveWebForProductCards({
      findActiveRunBindingByThread: async ({ sessionId }) => (sessionId === 'session-a' ? ({ orgId: 'org-a', workItemId: 'card-1' } as never) : null),
      get: async ({ id }) => (id === 'card-1' ? ({ board: 'product' } as never) : null),
    });
    expect(await live(where)).toBe(true);
    expect(await live({ ...where, sessionId: 'other' })).toBe(false);
  });

  it("keeps a generated image as the card's attachment, or the session's without a card", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-image-'));
    const path = join(dir, 'fox.png');
    writeFileSync(path, 'png-bytes');
    const ingested: Array<Record<string, unknown>> = [];
    const keep = (bound: boolean) =>
      codexGeneratedImageKeeper({
        attachments: {
          ingest: async input => {
            ingested.push({ ...input, body: await bytes(input.body) });
            return {} as never;
          },
        },
        workItems: { findActiveRunBindingForSession: async () => (bound ? ({ workItemId: 'card-1' } as never) : null) },
      });
    await keep(true)({ ...where, userId: 'user-a' }, { path, prompt: 'A fox' });
    await keep(false)({ ...where, userId: 'user-a' }, { path });
    expect(ingested).toEqual([
      { orgId: 'org-a', owner: { workItemId: 'card-1', factoryProjectId: 'factory-a' }, name: 'fox.png', body: 'png-bytes', source: 'chat', addedBy: 'user-a' },
      { orgId: 'org-a', owner: { sessionId: 'session-a', factoryProjectId: 'factory-a' }, name: 'fox.png', body: 'png-bytes', source: 'chat', addedBy: 'user-a' },
    ]);
  });
});
