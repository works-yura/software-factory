import { describe, expect, it } from 'vitest';

import { AgentUserSignaller } from '../signal/agent-user-signaller.ts';
import { RecordingRunner } from '../testing/fixtures.ts';
import { AgentReaper } from './agent-reaper.ts';
import { findLeftovers, MACOS_SYSTEM_PREFIXES, type LeftoverPolicy } from './leftover-policy.ts';
import { parseElapsed, parsePs, PsProcessTable, type ProcessRow } from './process-table.ts';

const SERVER = 500;
const policy: LeftoverPolicy = { agentUser: 'factory', serverPid: SERVER, idleGraceSeconds: 600, maxAgeSeconds: 6 * 3600, systemPrefixes: MACOS_SYSTEM_PREFIXES };
const row = (pid: number, ppid: number, user: string, ageSeconds: number, command: string): ProcessRow => ({ pid, ppid, user, ageSeconds, command });

// The server, and a turn under it: sh (server user) → sudo (root) → the agent's CLI.
const turn = [row(1, 0, 'root', 9e5, '/sbin/launchd'), row(SERVER, 1, 'yura', 1e4, 'node mastra'), row(501, SERVER, 'yura', 60, '/bin/sh -c …'), row(502, 501, 'root', 60, '/usr/bin/sudo -n -u factory'), row(503, 502, 'factory', 60, 'claude -p')];
const daemon = (age: number) => row(900, 1, 'factory', age, '/Users/factory/.gradle/jdk/bin/java GradleDaemon');
const system = row(901, 1, 'factory', 9e4, '/usr/sbin/cfprefsd agent');
const owners = [row(902, 1, 'yura', 9e4, '/usr/bin/python3 -m http.server')];

describe('parseElapsed', () => {
  it.each([['00:05', 5], ['12:34', 754], ['01:00:00', 3600], ['2-03:04:05', 2 * 86400 + 3 * 3600 + 4 * 60 + 5]])('%s is %d s', (text, seconds) => expect(parseElapsed(text)).toBe(seconds));
  it('refuses anything else', () => expect(() => parseElapsed('soon')).toThrow());
});

describe('parsePs', () => {
  it('keeps the whole command, spaces and all, and skips broken lines', () => {
    expect(parsePs('  42     1 factory   01:02 /bin/sh -c a b\ngarbage\n 7 1 root bad x\n')).toEqual([row(42, 1, 'factory', 62, '/bin/sh -c a b')]);
  });
  it('reads the real table, the server among it', async () => {
    const rows = await new PsProcessTable().list();
    expect(rows.find(r => r.pid === process.pid)?.ppid).toBe(process.ppid);
  });
});

describe('findLeftovers', () => {
  it('leaves a running turn alone, however old', () => {
    expect(findLeftovers(turn.map(r => ({ ...r, ageSeconds: 9e5 })), policy)).toEqual([]);
  });
  it('stops a detached process once no turn runs and the grace is over', () => {
    expect(findLeftovers([...turn.slice(0, 2), daemon(599)], policy)).toEqual([]);
    expect(findLeftovers([...turn.slice(0, 2), daemon(600)], policy)).toEqual([900]);
  });
  it('while turns run, only past the maximum age', () => {
    expect(findLeftovers([...turn, daemon(3600)], policy)).toEqual([]);
    expect(findLeftovers([...turn, daemon(6 * 3600)], policy)).toEqual([900]);
  });
  it("never the user's macOS services nor anyone else's processes", () => {
    expect(findLeftovers([...turn.slice(0, 2), system, ...owners], { ...policy, idleGraceSeconds: 0 })).toEqual([]);
  });
  it("after a restart, the old server's turns are left over", () => {
    expect(findLeftovers(turn, { ...policy, serverPid: 777, idleGraceSeconds: 0 })).toEqual([503]);
  });
  it('survives a parent loop', () => {
    expect(findLeftovers([row(10, 11, 'factory', 9e5, 'a'), row(11, 10, 'factory', 9e5, 'b')], policy)).toEqual([10, 11]);
  });
});

describe('AgentReaper', () => {
  const quiet = { info: () => {}, warn: () => {} };
  it('kills what is left over, as the agent user, in one kill', async () => {
    const runner = new RecordingRunner();
    const reaper = new AgentReaper({ list: async () => [...turn.slice(0, 2), daemon(9e3), row(903, 1, 'factory', 9e3, 'node dev-server')] }, new AgentUserSignaller('factory', runner), policy, quiet);
    expect(await reaper.sweep()).toEqual([900, 903]);
    expect(runner.calls).toEqual([['/usr/bin/sudo', '-n', '-u', 'factory', '--', '/bin/kill', '-s', 'KILL', '--', '900', '903']]);
  });
  it('kills nothing when nothing is left over', async () => {
    const runner = new RecordingRunner();
    await new AgentReaper({ list: async () => turn }, new AgentUserSignaller('factory', runner), policy, quiet).sweep();
    expect(runner.calls).toEqual([]);
  });
  it('reports a failed sweep and goes on', async () => {
    const warned: string[] = [];
    const reaper = new AgentReaper({ list: async () => Promise.reject(new Error('ps died')) }, { signalProcesses: async () => {} }, policy, { info: () => {}, warn: m => void warned.push(m) });
    expect(await reaper.sweep()).toEqual([]);
    expect(warned[0]).toContain('ps died');
  });
  it('starts with a pass without grace, then sweeps on its interval until stopped', async () => {
    const killed: number[][] = [];
    const reaper = new AgentReaper({ list: async () => [...turn.slice(0, 2), daemon(5)] }, { signalProcesses: async pids => void killed.push([...pids]) }, policy, quiet);
    const stop = reaper.start(10);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(killed).toEqual([[900]]);
    stop();
  });
});

describe('AgentUserSignaller.signalProcesses', () => {
  it('refuses groups and init', async () => {
    await expect(new AgentUserSignaller('factory', new RecordingRunner()).signalProcesses([42, 1], 'SIGKILL')).rejects.toThrow(RangeError);
  });
  it('runs nothing for no pids', async () => {
    const runner = new RecordingRunner();
    await new AgentUserSignaller('factory', runner).signalProcesses([], 'SIGKILL');
    expect(runner.calls).toEqual([]);
  });
});
