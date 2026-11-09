import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLAUDE_TOOL_CATEGORIES, type ClaudeToolCategory, type ClaudeToolPolicy } from '../src/permissions.ts';
import { PROBES, permissionsAsked, probeScript } from './probes.ts';
import { contractSession, type ContractSession } from './setup.ts';

let open: ContractSession | undefined;
afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

async function start(category: ClaudeToolCategory, policy: ClaudeToolPolicy) {
  const probe = PROBES[category];
  // Every other category denied: only the probe's own policy decides.
  const categories = Object.fromEntries(CLAUDE_TOOL_CATEGORIES.map(other => [other, other === category ? policy : 'deny']));
  let session!: ContractSession;
  session = await contractSession({ script: probeScript(probe, () => session), permissions: { categories } });
  await writeFile(join(session.cwd, 'seed.txt'), 'SEED-CONTENT\n');
  open = session;
  return { session, probe };
}

describe.each(CLAUDE_TOOL_CATEGORIES)('category %s against the real CLI', category => {
  it('allow: the call runs without asking', async () => {
    const { session, probe } = await start(category, 'allow');
    expect(await session.say('Go.')).toBe('complete');
    expect(permissionsAsked(session)).toEqual([]);
    expect(probe.ran(session)).toBe(true);
  });

  it('deny: the call never runs and nobody is asked', async () => {
    const { session, probe } = await start(category, 'deny');
    expect(await session.say('Go.')).toBe('complete');
    expect(permissionsAsked(session)).toEqual([]);
    expect(probe.ran(session)).toBe(false);
  });

  it('ask, then allowed: parks, runs on the retry, and does not ask again this session', async () => {
    const { session, probe } = await start(category, 'ask');
    expect(await session.say('Go.')).toBe('suspended');
    expect(session.session.pendingPermission?.toolName).toBe(probe.tool);
    expect(probe.ran(session)).toBe(false);

    expect(await session.answer(true)).toBe('complete');
    expect(probe.ran(session)).toBe(true);
    expect(await session.say('Once more.')).toBe('complete');
    expect(permissionsAsked(session)).toEqual([probe.tool]);
  });

  it('ask, then denied: the call never runs and Claude is told', async () => {
    const { session, probe } = await start(category, 'ask');
    expect(await session.say('Go.')).toBe('suspended');
    expect(await session.answer(false)).toBe('complete');
    expect(probe.ran(session)).toBe(false);
    expect(session.session.pendingPermission).toBeUndefined();
    expect(session.lastModelText()).toBe('TOLD-DENIED');
  });
});
