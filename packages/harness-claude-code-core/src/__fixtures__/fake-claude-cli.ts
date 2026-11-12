// A fake `claude` executable on disk, for tests that spawn the CLI the way the server does (a real
// process, found by the resolver, in its own process group) instead of injecting a `spawn`. Each
// run plays the next scripted turn: the stream-json lines once the prompt is on stdin, then it exits
// when its input is closed, as `claude -p --input-format stream-json` does.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeClaudeCliTurn {
  /** Stream-json lines printed once the prompt arrived (see `fixture()`). */
  lines: string[];
  /** Exits with this right after the lines, input closed or not; without it, exits 0 once stdin closes. */
  exitCode?: number;
  stderr?: string;
  /** Kills itself with SIGKILL after the lines: a crash mid-turn, with no last word. */
  crash?: boolean;
  /** Never exits on its own; only a signal ends it. */
  hang?: boolean;
  /** Starts a long-lived child in its process group (a tool, an MCP server) and writes its pid here. */
  toolPidFile?: string;
}

export interface FakeClaudeCliRun {
  pid: number;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface FakeClaudeCli {
  /** The executable's path. */
  readonly path: string;
  /** Every run so far, in order. */
  runs(): FakeClaudeCliRun[];
}

/** Writes an executable `claude` into `dir` that plays `turns` in order (the last one repeats). */
export function installFakeClaudeCli(dir: string, turns: FakeClaudeCliTurn[], name = 'claude'): FakeClaudeCli {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(`${path}.json`, JSON.stringify({ turns }));
  // The node running the tests, by absolute path: a launchd-like PATH has no `node` on it.
  writeFileSync(path, `#!${process.execPath}\n${FAKE_CLAUDE_SOURCE}`);
  chmodSync(path, 0o755);
  return {
    path,
    runs: () =>
      existsSync(`${path}.runs`)
        ? readFileSync(`${path}.runs`, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as FakeClaudeCliRun)
        : [],
  };
}

const FAKE_CLAUDE_SOURCE = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const self = __filename;
const { turns } = JSON.parse(fs.readFileSync(self + '.json', 'utf8'));
const runs = fs.existsSync(self + '.runs') ? fs.readFileSync(self + '.runs', 'utf8').split('\n').filter(Boolean).length : 0;
fs.appendFileSync(self + '.runs', JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + '\n');
const turn = turns[Math.min(runs, turns.length - 1)];
let buffer = '';
let started = false;
let played = false;
let inputEnded = false;
const finish = () => {
  if (!played || turn.hang || (!inputEnded && turn.exitCode === undefined)) return;
  if (turn.stderr) process.stderr.write(turn.stderr);
  // Exits even while stdin is still open, once what it printed is out.
  process.stdout.write('', () => process.exit(turn.exitCode || 0));
};
const play = () => {
  if (turn.toolPidFile) {
    const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(turn.toolPidFile, String(tool.pid));
    tool.unref();
  }
  for (const line of turn.lines) process.stdout.write(line + '\n');
  if (turn.crash) {
    process.stdout.write('', () => process.kill(process.pid, 'SIGKILL'));
    return;
  }
  if (turn.hang) setInterval(() => {}, 1000);
  played = true;
  finish();
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (!started && buffer.includes('\n')) {
    started = true;
    play();
  }
});
process.stdin.on('end', () => {
  inputEnded = true;
  finish();
});
`;
