import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentEvent, AgentRunEndReason } from '@factory/harness';

import type { ClaudeTranscriptEntry } from '../src/events.ts';
import { createClaudeCodeHarness, type ClaudeCodeHarnessConfig } from '../src/harness.ts';
import type { ClaudeToolPermissions } from '../src/permissions.ts';
import type { ClaudeCodeSession } from '../src/session.ts';
import { createInMemorySessionStore } from '../src/store.ts';
import { startMockAnthropic, type MockAnthropic, type ModelScript } from './mock-anthropic.ts';

/** The CLI under test: `CLAUDE_CONTRACT_BIN`, or `claude` on PATH. */
export const CLAUDE_BIN = process.env.CLAUDE_CONTRACT_BIN || 'claude';

const ECHO_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'echo-mcp-server.mjs');

/** The host's own MCP server (the Factory's tools in production): trusted, never governed by the MCP category. */
export const TRUSTED_MCP = 'factory';
/** Another MCP server: governed by the MCP category. */
export const OTHER_MCP = 'thirdparty';

/** What the server allows every Factory session (`DEFAULT_CLAUDE_FACTORY_ALLOWED_TOOLS`). */
export const PRODUCTION_ALLOWED_TOOLS = ['TodoWrite', `mcp__${TRUSTED_MCP}`];

export function claudeVersion(): string {
  return execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
}

export interface ContractSession {
  mock: MockAnthropic;
  session: ClaudeCodeSession;
  events: AgentEvent[];
  transcript: ClaudeTranscriptEntry[];
  cwd: string;
  root: string;
  /** The settings the next turn reads; change them between turns like Settings → Behavior does. */
  permissions: ClaudeToolPermissions | undefined;
  /** Texts the MCP server `server`'s echo tool was really called with. */
  echoed(server: string): string[];
  /** Sends a person's message and waits for the run it starts to end. */
  say(text: string): Promise<AgentRunEndReason | undefined>;
  /** Answers the parked permission and waits for the retry run to end. */
  answer(approved: boolean): Promise<AgentRunEndReason | undefined>;
  /** What the scripted model was last told about its tool call (`RESULT error=…`), or its last text. */
  lastModelText(): string;
  dispose(): Promise<void>;
}

/**
 * A Claude Code session run by the real CLI against the scripted model, in a
 * throwaway directory with its own config dir and HOME, so nothing touches the
 * person's `~/.claude` and no subscription is spent.
 */
export async function contractSession(options: {
  script: ModelScript;
  permissions?: ClaudeToolPermissions;
  config?: Partial<ClaudeCodeHarnessConfig>;
}): Promise<ContractSession> {
  const mock = await startMockAnthropic(options.script);
  const root = await mkdtemp(join(tmpdir(), 'claude-contract-'));
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const echoLog = (server: string) => join(root, `${server}.echo.log`);
  const state = { permissions: options.permissions };
  const harness = createClaudeCodeHarness({
    store: createInMemorySessionStore(),
    command: CLAUDE_BIN,
    credentials: async () => ({ ANTHROPIC_API_KEY: 'sk-ant-contract-test', ANTHROPIC_BASE_URL: mock.url }),
    cwdFor: () => cwd,
    configDir: () => join(root, 'config'),
    tempDir: root,
    model: 'claude-haiku-5-5',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: root,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
    passEnv: ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER'],
    turnTimeoutMs: 90_000,
    // As the server runs Factory sessions (packages/server/src/claude/harness.ts).
    allowedTools: PRODUCTION_ALLOWED_TOOLS,
    trustedMcpServers: [TRUSTED_MCP],
    mcpConfig: {
      mcpServers: Object.fromEntries(
        [TRUSTED_MCP, OTHER_MCP].map(server => [
          server,
          { type: 'stdio', command: process.execPath, args: [ECHO_SERVER], env: { ECHO_LOG: echoLog(server) } },
        ]),
      ),
    },
    permissions: () => state.permissions,
    ...options.config,
  });
  const session = await harness.createSession({ sessionId: 'contract', threadId: 'thread-1', resourceId: 'fp-1' });
  const events: AgentEvent[] = [];
  session.subscribe(event => events.push(event));
  const transcript: ClaudeTranscriptEntry[] = [];
  session.onTranscript(entry => transcript.push(entry));
  const requestContext = harness.runContext(session, { userId: 'user-1', orgId: 'org-1', threadId: 'thread-1', resourceId: 'fp-1' });

  const nextEnd = () =>
    new Promise<AgentRunEndReason | undefined>(resolve => {
      const off = session.subscribe(event => {
        if (event.type !== 'agent_end') return;
        off();
        resolve(event.reason);
      });
    });
  let signals = 0;
  return {
    mock,
    session,
    events,
    transcript,
    cwd,
    root,
    get permissions() {
      return state.permissions;
    },
    set permissions(next) {
      state.permissions = next;
    },
    echoed(server) {
      const file = echoLog(server);
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    },
    async say(text) {
      const end = nextEnd();
      await session.sendSignal(
        { id: `signal-${++signals}`, type: 'user', tagName: 'user', contents: text },
        { requestContext, requireDelivery: true },
      ).accepted;
      return end;
    },
    async answer(approved) {
      const end = nextEnd();
      await session.respondToToolApproval({ approved });
      return end;
    },
    lastModelText() {
      const texts = transcript.filter(entry => entry.kind === 'text') as Array<{ kind: 'text'; text: string }>;
      return texts.at(-1)?.text ?? '';
    },
    async dispose() {
      await mock.close();
      // Only ever the throwaway directory this helper made.
      if (root.startsWith(join(tmpdir(), 'claude-contract-'))) await rm(root, { recursive: true, force: true });
    },
  };
}
