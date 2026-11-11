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
  /** Told of every stream-json message the harness writes to stdin after the prompt (a steer, a control response). */
  onInput?: (message: Record<string, unknown>) => void;
}

export interface FakeCall {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  detached: boolean;
  /** The prompt: the text of the first user message written to stdin. */
  stdin?: string;
  /** Every stream-json message written to stdin, the prompt first. */
  inputs: Array<Record<string, unknown>>;
  /** The harness closed stdin. */
  inputClosed: boolean;
  killed: string[];
  /** Each `--mcp-config` value as the CLI would read it at spawn: file contents (with the file's mode) or inline JSON. */
  mcpConfigs: Array<{ path?: string; mode?: number; config: unknown }>;
  /** The gate server's script as the CLI would start it at spawn, when its config names one that exists. */
  gateScript?: { path: string; mode: number; source: string };
}

function readGateScript(configs: FakeCall['mcpConfigs']): FakeCall['gateScript'] {
  for (const { config } of configs) {
    const gate = (config as { mcpServers?: { factory_gate?: { args?: string[] } } }).mcpServers?.factory_gate;
    const path = gate?.args?.[0];
    if (path && existsSync(path)) return { path, mode: statSync(path).mode & 0o777, source: readFileSync(path, 'utf8') };
  }
  return undefined;
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
      inputs: [],
      inputClosed: false,
      killed: [],
      mcpConfigs: readMcpConfigs(args),
    };
    const gateScript = readGateScript(call.mcpConfigs);
    if (gateScript) call.gateScript = gateScript;
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
        write: (chunk: string) => {
          if (call.inputClosed) throw new Error('write after end');
          for (const line of chunk.split('\n').filter(Boolean)) {
            const message = JSON.parse(line) as Record<string, unknown>;
            call.inputs.push(message);
            if (call.inputs.length === 1) {
              const content = (message.message as { content?: unknown } | undefined)?.content;
              call.stdin = typeof content === 'string' ? content : JSON.stringify(content);
              void play();
            } else {
              turn.onInput?.(message);
            }
          }
          return true;
        },
        end: () => {
          call.inputClosed = true;
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
