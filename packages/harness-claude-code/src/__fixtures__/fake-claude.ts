import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ClaudeChildProcess, ClaudeSpawn } from '../cli.ts';

export function fixture(name: string): string[] {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '');
}

export interface FakeTurn {
  lines: string[];
  exitCode?: number;
  stderr?: string;
  /** Lines before this index stream at once; the rest wait for `hold`. */
  holdAt?: number;
  hold?: Promise<void>;
  /** Never exit on its own; only a kill ends it. */
  hang?: boolean;
  /** Lines the process still prints while it is being stopped, like the real CLI's last words. */
  linesOnKill?: string[];
  /** Deliver the output in arbitrary chunks instead of whole lines. */
  chunkSize?: number;
}

export interface FakeCall {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  detached: boolean;
  stdin?: string;
  killed: string[];
  /** Each `--mcp-config` value as the CLI would read it at spawn: file contents (with the file's mode) or inline JSON. */
  mcpConfigs: Array<{ path?: string; mode?: number; config: unknown }>;
}

function readMcpConfigs(args: string[]): FakeCall['mcpConfigs'] {
  const index = args.indexOf('--mcp-config');
  if (index === -1) return [];
  const values: FakeCall['mcpConfigs'] = [];
  for (let i = index + 1; i < args.length && !args[i]!.startsWith('--'); i += 1) {
    const value = args[i]!;
    if (existsSync(value)) {
      values.push({ path: value, mode: statSync(value).mode & 0o777, config: JSON.parse(readFileSync(value, 'utf8')) });
    } else {
      values.push({ config: JSON.parse(value) });
    }
  }
  return values;
}

/** A scripted `claude`: each spawn plays the next turn's recorded stream-json. */
export function fakeClaude(turns: FakeTurn[]) {
  const calls: FakeCall[] = [];
  let next = 0;
  const spawn: ClaudeSpawn = (command, args, options) => {
    const turn = turns[next] ?? { lines: [] };
    next += 1;
    const call: FakeCall = {
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      detached: options.detached,
      killed: [],
      mcpConfigs: readMcpConfigs(args),
    };
    calls.push(call);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let closed = false;
    let killed = false;
    const close = (code: number | null, signal: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      child.emit('close', code, signal);
    };
    const output = turn.lines.map(line => `${line}\n`);
    const play = async () => {
      for (let index = 0; index < output.length; index += 1) {
        if (turn.holdAt === index && turn.hold) await turn.hold;
        await new Promise(resolve => setImmediate(resolve));
        if (killed) return;
        const text = output[index]!;
        const size = turn.chunkSize ?? text.length;
        for (let offset = 0; offset < text.length; offset += size) stdout.emit('data', text.slice(offset, offset + size));
      }
      if (turn.holdAt === output.length && turn.hold) await turn.hold;
      await new Promise(resolve => setImmediate(resolve));
      if (killed || turn.hang) return;
      if (turn.stderr) stderr.emit('data', turn.stderr);
      close(turn.exitCode ?? 0, null);
    };
    const fake = Object.assign(child, {
      pid: 4242 + calls.length,
      stdout,
      stderr,
      stdin: {
        end: (chunk?: string) => {
          call.stdin = chunk;
          void play();
        },
      },
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        call.killed.push(signal);
        killed = true;
        setImmediate(() => {
          for (const line of turn.linesOnKill ?? []) stdout.emit('data', `${line}\n`);
          close(null, signal);
        });
        return true;
      },
    });
    return fake as unknown as ClaudeChildProcess;
  };
  return { spawn, calls };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
