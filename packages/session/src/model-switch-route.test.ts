import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createHarnessModelRegistry } from '@factory/harness/models/registry';
import { codexStubModels } from '@factory/harness/models/registry.testFixtures';

import { createModelSwitchRoute } from './session-access.ts';

function buildApp(registry = createHarnessModelRegistry([codexStubModels(new Set(['s-1']))])) {
  const app = new Hono();
  app.use('*', createModelSwitchRoute({ models: () => registry, viewer: () => ({ userId: 'u1', orgId: 'o1' }) }));
  app.all('*', c => c.json({ reached: true }));
  return app;
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const MODEL = '/api/agent-controller/code/sessions/s-1/model';

describe('createModelSwitchRoute', () => {
  it("sets a pick on the session's harness, whichever it is", async () => {
    const response = await post(buildApp(), MODEL, { modelId: 'gpt-5.3-codex', options: [{ id: 'reasoningEffort', value: 'high' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      appliesFrom: 'next-turn',
      modelSelection: { instanceId: 'codex-stub', model: 'gpt-5.3-codex', options: [{ id: 'reasoningEffort', value: 'high' }] },
    });
  });

  it("answers the harness's refusal, a malformed body, and a pick from another harness", async () => {
    const app = buildApp();
    const unknown = await post(app, MODEL, { modelId: 'nope/model' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/^Unknown model nope\/model/);
    expect((await post(app, MODEL, { modelId: 'gpt-5-mini', options: [{ id: 'fastMode', value: true }] })).status).toBe(400);
    expect((await post(app, MODEL, {})).status).toBe(400);
    expect((await post(app, MODEL, { modelId: 'gpt-5-mini', options: 'fast' })).status).toBe(400);
    expect((await post(app, MODEL, { modelId: 'gpt-5-mini', instanceId: 'mastra' })).status).toBe(409);
    expect((await post(app, '/api/agent-controller/code/sessions/nobody/model', { modelId: 'gpt-5-mini' })).status).toBe(404);
  });

  it('passes other routes on, and answers 503 before the registry exists', async () => {
    const switchSessionModel = vi.fn();
    const app = buildApp({ ...createHarnessModelRegistry(), switchSessionModel });
    expect((await post(app, '/api/agent-controller/code/sessions/s-1/messages', { modelId: 'nope' })).status).toBe(200);
    expect(switchSessionModel).not.toHaveBeenCalled();
    const early = new Hono();
    early.use('*', createModelSwitchRoute({ models: () => undefined, viewer: () => ({ userId: '', orgId: '' }) }));
    expect((await post(early, MODEL, { modelId: 'x' })).status).toBe(503);
  });
});
