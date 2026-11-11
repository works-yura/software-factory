import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createClaudeFactoryChatGuard } from './factory-chat-guard.ts';

const CLAUDE_FACTORY = '11111111-1111-4111-8111-111111111111';
const MASTRA_FACTORY = '22222222-2222-4222-8222-222222222222';
const CODEX_FACTORY = '33333333-3333-4333-8333-333333333333';

function app() {
  const reached: string[] = [];
  const hono = new Hono();
  hono.use(
    '*',
    createClaudeFactoryChatGuard({
      controllerId: 'code',
      factoryHarness: async id =>
        id === CLAUDE_FACTORY ? 'claude-code' : id === CODEX_FACTORY ? 'codex' : id === MASTRA_FACTORY ? 'mastra' : undefined,
    }),
  );
  hono.all('*', async c => {
    // The raw request, as the Mastra routes behind the guard read it.
    const body = c.req.method === 'POST' ? await c.req.raw.json().catch(() => null) : null;
    reached.push(`${c.req.method} ${c.req.path}${body ? ` ${JSON.stringify(body)}` : ''}`);
    return c.json({ ok: true });
  });
  return { hono, reached };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('a Claude Code Factory never becomes a Mastra chat under its own id', () => {
  it('refuses creating, threading or messaging a session named by a Claude Code Factory', async () => {
    const { hono, reached } = app();
    for (const [path, init] of [
      ['/api/agent-controller/code/sessions', post({ sessionId: CLAUDE_FACTORY })],
      [`/api/agent-controller/code/sessions/${CLAUDE_FACTORY}/threads`, post({})],
      [`/api/agent-controller/code/sessions/${CLAUDE_FACTORY}/messages`, post({ text: 'hi' })],
    ] as const) {
      const response = await hono.request(path, init);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('runs on Claude Code') });
    }
    expect(reached).toEqual([]);
    // A Codex Factory's id is not a Mastra session either.
    const codex = await hono.request('/api/agent-controller/code/sessions', post({ sessionId: CODEX_FACTORY }));
    expect(codex.status).toBe(409);
    await expect(codex.json()).resolves.toMatchObject({ error: expect.stringContaining('runs on Codex') });
    expect(reached).toEqual([]);
  });

  it("leaves a Mastra Factory's chat, real sessions and reads alone, and the body readable behind it", async () => {
    const { hono, reached } = app();
    expect((await hono.request('/api/agent-controller/code/sessions', post({ sessionId: MASTRA_FACTORY }))).status).toBe(200);
    expect((await hono.request('/api/agent-controller/code/sessions/session-1/messages', post({ text: 'hi' }))).status).toBe(200);
    expect((await hono.request(`/api/agent-controller/code/sessions/${CLAUDE_FACTORY}`)).status).toBe(200);
    expect(reached).toEqual([
      `POST /api/agent-controller/code/sessions {"sessionId":"${MASTRA_FACTORY}"}`,
      'POST /api/agent-controller/code/sessions/session-1/messages {"text":"hi"}',
      `GET /api/agent-controller/code/sessions/${CLAUDE_FACTORY}`,
    ]);
  });
});
