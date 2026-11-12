// The server's turn-harness wiring the way production runs it (ADR-0038), against real CLI processes:
// a launchd service's environment (bare PATH, no nvm), the CLIs where they install (`~/.local/bin`
// for Claude Code, the deployment's FACTORY_CODEX_COMMAND for Codex), the executables resolved by
// `harnessExecutableFor` as `MastraFactory.prepare` resolves them, the harnesses built by the
// server's own factories with those executables, and the facets wrapped in
// `withExecutableAvailability`. Only the CLIs are fakes: scripted executables on disk.
//
// The incident this guards: under launchd every Claude Code run failed `spawn claude ENOENT`
// because the CLI lived in ~/.local/bin, and nothing ran the wiring under such an environment.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@factory/harness';
import { harnessCommandAvailable, isHarnessExecutableUnavailable, resolveHarnessExecutable } from '@factory/harness/executable';
import { withExecutableAvailability, type HarnessModels } from '@factory/harness/models/facet';
import { createInMemorySessionStore } from '@factory/harness-claude-code';
import { fixture } from '@factory/harness-claude-code/__fixtures__/fake-claude';
import { installFakeClaudeCli } from '@factory/harness-claude-code/__fixtures__/fake-claude-cli';
import { createInMemoryCodexSessionStore } from '@factory/harness-codex';
import { installFakeCodexCli } from '@factory/harness-codex/__fixtures__/fake-codex-cli';
import { FAKE_CODEX_MODELS } from '@factory/harness-codex/testkit';
import { parseCodexModelListResponse } from '@factory/harness-codex/models';

import { createClaudeFactoryHarness } from './claude/harness.ts';
import { createCodexFactoryHarness } from './codex/harness.ts';
import { CLAUDE_CODE_EXECUTABLE, CODEX_EXECUTABLE, harnessExecutableFor, reportHarnessExecutables } from './harness-executables.ts';

/** What launchd gives a service. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The server's environment under launchd, with a home of its own and a secret of the server's. */
function launchdEnvironment() {
  const home = tempDir('factory-launchd-home-');
  return { home, env: { PATH: LAUNCHD_PATH, HOME: home, USER: 'factory', DATABASE_URL: 'postgres://server-secret' } };
}

/** A facet whose own availability says yes: what is left to say no is the executable. */
function modelsStub(instanceId: string): HarnessModels {
  return {
    instanceId,
    harnessId: instanceId,
    displayName: instanceId,
    owns: async () => false,
    availability: async () => ({ available: true }),
    list: async () => [],
    defaultSelection: async () => null,
    catalogDefault: async () => null,
    check: async () => ({ ok: false, status: 400, error: 'unused' }) as never,
    getSelection: async () => null,
    setSelection: async () => ({ ok: false, status: 400, error: 'unused' }),
  };
}

const viewer = { viewer: { userId: 'user-a', orgId: 'org-a' } };
const row = { orgId: 'org-a', userId: 'user-a', factoryProjectId: 'factory-a' };
const mcp = { url: (id: string) => `https://factory.test/mcp/${id}`, tokens: { sign: () => 'token' } };
const firstError = (events: AgentEvent[]) => events.find((event): event is Extract<AgentEvent, { type: 'error' }> => event.type === 'error')?.error;

/**
 * Whether this machine has a `claude` where the server looks besides HOME (the node's bin,
 * Homebrew, /usr/local/bin): then "not installed" cannot be staged here.
 */
const claudeOutsideHome = resolveHarnessExecutable({ harness: 'Claude Code', name: 'claude', env: { PATH: LAUNCHD_PATH, HOME: join(tmpdir(), 'factory-no-home') } }).found;

describe.skipIf(process.platform === 'win32')('turn harnesses wired as production runs them, under launchd', () => {
  it.skipIf(claudeOutsideHome)(
    'Claude Code: unavailable while `claude` is missing, a send fails as harness_not_configured, and installing it into ~/.local/bin works without a restart',
    async () => {
      const { home, env } = launchdEnvironment();
      // apps/server's config: no FACTORY_CLAUDE_CODE_COMMAND, the server's own environment.
      const config = { env };
      const executable = harnessExecutableFor(config, CLAUDE_CODE_EXECUTABLE)!;
      const models = withExecutableAvailability(modelsStub('claude-code'), executable);
      const factory = createClaudeFactoryHarness({
        ...config,
        command: executable,
        store: createInMemorySessionStore(),
        sessionConfigRoot: tempDir('factory-claude-config-'),
        sessions: { getBySessionId: async () => row as never },
        credentials: async () => ({ ANTHROPIC_API_KEY: 'sk-turn' }),
        cwdFor: () => home,
        mcp,
      });
      const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'thread-a', resourceId: 'factory-a' });
      const events: AgentEvent[] = [];
      session.subscribe(event => events.push(event));
      const transcript: unknown[] = [];
      session.onTranscript(entry => transcript.push(entry));
      const requestContext = factory.harness.runContext(session, { userId: 'user-a', orgId: 'org-a', threadId: 'thread-a', resourceId: 'factory-a' });
      const turn = async (id: string) => {
        const ended = new Promise<string | undefined>(resolve => {
          const off = session.subscribe(event => {
            if (event.type !== 'agent_end') return;
            off();
            resolve(event.reason);
          });
        });
        await session.sendSignal({ id, type: 'user', tagName: 'user', contents: 'Update the README' }, { requestContext, requireDelivery: true }).accepted;
        return ended;
      };

      // Missing: the boot log says where it looked, the picker says why, a send fails once with it.
      const log = { info: vi.fn(), warn: vi.fn() };
      expect((await reportHarnessExecutables([executable], log))[0]).toMatchObject({ found: false });
      expect(log.warn.mock.calls[0]![0]).toContain(join(home, '.local', 'bin'));
      expect(await models.availability!(viewer)).toMatchObject({ available: false, reasonCode: 'executable_missing' });
      const looked = vi.spyOn(executable, 'command');
      expect(await turn('one')).toBe('error');
      expect(isHarnessExecutableUnavailable(firstError(events))).toBe(true);
      expect(looked).toHaveBeenCalledTimes(1);

      // Installed while the server runs, where Claude Code's installer puts it.
      const cli = installFakeClaudeCli(join(home, '.local', 'bin'), [{ lines: fixture('turn-complete.jsonl') }]);
      expect(await models.availability!(viewer)).toEqual({ available: true });
      expect(await turn('two')).toBe('complete');
      expect(JSON.stringify(transcript)).toContain('I added a usage section.');
      expect(executable.resolve()).toMatchObject({ found: true, path: cli.path, source: 'well-known' });
      const [run] = cli.runs();
      expect(run!.env.PATH).toBe(LAUNCHD_PATH);
      expect(run!.env.DATABASE_URL).toBeUndefined();
      expect(run!.env.ANTHROPIC_API_KEY).toBe('sk-turn');
    },
    20_000,
  );

  it(
    'Codex: unavailable while FACTORY_CODEX_COMMAND names nothing, a send fails as harness_not_configured, and installing it there works without a restart',
    async () => {
      const { home, env } = launchdEnvironment();
      const command = join(home, 'opt', 'codex', 'bin', 'codex');
      // apps/server's config with FACTORY_CODEX_COMMAND set.
      const config = { command, env };
      const executable = harnessExecutableFor(config, CODEX_EXECUTABLE)!;
      const models = withExecutableAvailability(modelsStub('codex'), executable);
      const factory = createCodexFactoryHarness({
        ...config,
        command: executable,
        store: createInMemoryCodexSessionStore(),
        sessionHomeRoot: tempDir('factory-codex-homes-'),
        credentials: {
          credentials: async () => ({
            tokens: { accessToken: 'at-1', chatgptAccountId: 'ws-1', planType: 'plus' },
            accountId: 'acc-1',
            credential: { label: 'alice@example.com', ownerId: 'user-a' },
          }),
          refresh: async () => undefined,
          onCredentialFailure: async () => {},
          usable: async () => true,
        },
        sessions: { getBySessionId: async () => row as never },
        projects: {
          get: async () => ({ id: 'factory-a', orgId: 'org-a', agentLanguage: 'en' }) as never,
          getById: async () => ({ id: 'factory-a', orgId: 'org-a', agentLanguage: 'en', harness: 'codex', createdBy: 'user-a' }) as never,
        },
        supervisorWorkdirRoot: tempDir('factory-codex-supervisor-'),
        cwdFor: () => home,
        mcp,
        catalog: async () => ({ available: true, models: parseCodexModelListResponse(FAKE_CODEX_MODELS) }),
      });
      const session = await factory.harness.createSession({ sessionId: 'session-a', threadId: 'session-a', resourceId: 'factory-a' });

      // `MastraFactory.prepare` asks this before it takes a Codex session (the binding's `available`).
      expect(harnessCommandAvailable(executable, 'codex', env)).toBe(false);
      expect(await models.availability!(viewer)).toMatchObject({ available: false, reasonCode: 'executable_missing' });
      // The send itself is refused (no run starts); the dispatcher classifies what it throws.
      const refused = await session.sendMessage({ content: 'Fix it' }).catch((error: unknown) => error);
      expect((refused as Error).message).toContain('`' + command + '` was not found');
      expect(isHarnessExecutableUnavailable(refused)).toBe(true);

      const cli = installFakeCodexCli(join(home, 'opt', 'codex', 'bin'), { reply: 'Fixed.' });
      expect(harnessCommandAvailable(executable, 'codex', env)).toBe(true);
      expect(await models.availability!(viewer)).toEqual({ available: true });
      const events: AgentEvent[] = [];
      session.subscribe(event => events.push(event));
      const r = await session.sendMessage({ content: 'Fix it' });
      expect(r).toEqual({ reason: 'complete' });
      const [run] = cli.runs();
      expect(run!.args[0]).toBe('app-server');
      expect(run!.env.PATH).toBe(LAUNCHD_PATH);
      expect(run!.env.DATABASE_URL).toBeUndefined();
    },
    20_000,
  );
});
