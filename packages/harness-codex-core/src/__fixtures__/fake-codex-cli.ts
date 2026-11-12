// A fake `codex` executable on disk, for tests that spawn the CLI the way the server does (a real
// process found by the resolver, in its own process group) instead of injecting a `spawn`. It speaks
// just enough of `codex app-server` (JSON-RPC lines on stdio) to open a thread and run turns.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FAKE_CODEX_MODELS } from '../testkit.ts';

export interface FakeCodexCliSpec {
  /** Never answers `initialize` and ignores its input closing: a CLI that hangs, or one that is not the app-server. */
  silent?: boolean;
  /** What a turn does after it starts: reply (the default), hang until interrupted or killed, or crash. */
  turn?: 'reply' | 'hang' | 'crash';
  /** The reply's text. */
  reply?: string;
  /** Each turn starts a long-lived child in the process group (a command Codex runs) and writes its pid here. */
  toolPidFile?: string;
  /** The tool ignores SIGTERM, as a command that traps it would. */
  toolIgnoresSigterm?: boolean;
}

export interface FakeCodexCliRun {
  pid: number;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface FakeCodexCli {
  readonly path: string;
  runs(): FakeCodexCliRun[];
}

/** Writes an executable `codex` into `dir` that acts as `spec` says. */
export function installFakeCodexCli(dir: string, spec: FakeCodexCliSpec = {}, name = 'codex'): FakeCodexCli {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(`${path}.json`, JSON.stringify({ ...spec, models: FAKE_CODEX_MODELS }));
  // The node running the tests, by absolute path: a launchd-like PATH has no `node` on it.
  writeFileSync(path, `#!${process.execPath}\n${FAKE_CODEX_SOURCE}`);
  chmodSync(path, 0o755);
  return {
    path,
    runs: () =>
      existsSync(`${path}.runs`)
        ? readFileSync(`${path}.runs`, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as FakeCodexCliRun)
        : [],
  };
}

const FAKE_CODEX_SOURCE = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const self = __filename;
const spec = JSON.parse(fs.readFileSync(self + '.json', 'utf8'));
fs.appendFileSync(self + '.runs', JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let threads = 0;
let turns = 0;
const startTool = () => {
  if (!spec.toolPidFile) return;
  const source = (spec.toolIgnoresSigterm ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000);';
  const tool = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
  fs.writeFileSync(spec.toolPidFile, String(tool.pid));
  tool.unref();
};
const completed = (threadId, turnId, status) => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const reply = result => send({ id: message.id, result });
  const params = message.params || {};
  switch (message.method) {
    case 'initialize':
      if (!spec.silent) reply({ userAgent: 'factory/0.200.0 (fake)', codexHome: process.env.CODEX_HOME || '', platformFamily: 'unix', platformOs: 'macos' });
      return;
    case 'account/login/start':
      return reply({ type: params.type });
    case 'account/read':
      return reply({ account: null, requiresOpenaiAuth: true });
    case 'model/list':
      return reply(spec.models);
    case 'thread/start':
      threads += 1;
      return reply({ thread: { id: 'thread-' + threads, cwd: process.cwd() }, model: params.model || 'gpt-test-sol', cwd: process.cwd() });
    case 'thread/resume':
      return reply({ thread: { id: params.threadId, cwd: process.cwd() }, model: params.model || 'gpt-test-sol', cwd: process.cwd() });
    case 'turn/start': {
      turns += 1;
      const turnId = 'turn-' + turns;
      const threadId = params.threadId;
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      startTool();
      if (spec.turn === 'crash') {
        process.stdout.write('', () => process.kill(process.pid, 'SIGKILL'));
        return;
      }
      if (spec.turn === 'hang') return;
      const text = spec.reply || 'Done.';
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-' + turnId, delta: text } });
      send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg-' + turnId, text } } });
      completed(threadId, turnId, 'completed');
      return;
    }
    case 'turn/interrupt':
      reply({});
      completed(params.threadId, params.turnId, 'interrupted');
      return;
    default:
      send({ id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } });
  }
});
// A hung CLI does not notice its input closing either; only a signal ends it.
if (spec.silent) setInterval(() => {}, 1000);
else process.stdin.on('end', () => process.exit(0));
`;
