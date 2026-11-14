/**
 * What an agent must never reach on the machine it shares with the owner: the owner's files and
 * logins, the Factory server (its code, releases, database, port), system places that run code
 * as someone else, and the owner's processes. Each probe names a target the server user can
 * reach, so the suite checks both sides: the server can, the agent cannot.
 */

import { spawnSync } from 'node:child_process';
import { networkInterfaces, homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

export interface ReadProbe {
  what: string;
  /** The file or folder; the probe is skipped where it does not exist. */
  path: string;
  /** `cat` for a file, `ls` for a folder. */
  read: 'cat' | 'ls';
}

export interface WriteProbe {
  what: string;
  /** A folder the agent must not create files in; skipped where it does not exist. */
  folder: string;
}

export interface PortProbe {
  what: string;
  host: string;
  port: number;
}

/** A TCP port a process of the owner listens on, as lsof reports it. */
export interface Listener {
  command: string;
  /** `*` for every address. */
  address: string;
  port: number;
}

const home = homedir();
/** The checkout this suite runs from (`packages/agent-user/src/integration` is four levels down). */
const checkout = resolve(import.meta.dirname, '../../../..');
/** Where deploys keep releases, `current` and the card folders. */
const deployRoot = process.env.FACTORY_AGENT_USER_TEST_DEPLOY_ROOT ?? '/Volumes/dot/Project/factory';
/** Ports the owner accepts the agent reaching (`FACTORY_AGENT_USER_TEST_ALLOWED_PORTS=5000,7000`). */
export const allowedPorts = new Set(
  (process.env.FACTORY_AGENT_USER_TEST_ALLOWED_PORTS ?? '').split(',').map(Number).filter(port => Number.isInteger(port) && port > 0),
);

export const readProbes: readonly ReadProbe[] = [
  { what: 'the owner home', path: home, read: 'ls' },
  { what: 'the owner SSH keys', path: join(home, '.ssh'), read: 'ls' },
  { what: 'the owner SSH key', path: join(home, '.ssh/id_ed25519'), read: 'cat' },
  { what: 'the owner keychains', path: join(home, 'Library/Keychains'), read: 'ls' },
  { what: 'the Factory database', path: join(home, '.mastracode/factory-v4/mastra.db'), read: 'cat' },
  { what: 'the Claude login', path: join(home, '.claude/.credentials.json'), read: 'cat' },
  { what: 'the owner temp folder (server inputs)', path: tmpdir(), read: 'ls' },
  { what: 'the server .env in this checkout', path: join(checkout, 'apps/server/.env'), read: 'cat' },
  { what: 'this checkout', path: checkout, read: 'ls' },
  { what: 'the releases', path: join(deployRoot, 'releases'), read: 'ls' },
  { what: 'the running release .env', path: join(deployRoot, 'current/apps/server/.env'), read: 'cat' },
  { what: 'the running server code', path: join(deployRoot, 'current/package.json'), read: 'cat' },
  { what: 'the deploy log', path: join(deployRoot, 'deploys.log'), read: 'cat' },
  { what: 'the other projects', path: '/Volumes/dot/Project', read: 'ls' },
  { what: 'the data volume', path: '/Volumes/dot', read: 'ls' },
  { what: 'the SDKs', path: '/Volumes/dot/SDK', read: 'ls' },
];

export const writeProbes: readonly WriteProbe[] = [
  { what: 'the running server code', folder: join(deployRoot, 'current/apps/server') },
  { what: 'the releases', folder: join(deployRoot, 'releases') },
  { what: 'next to the card folders', folder: deployRoot },
  { what: 'this checkout', folder: checkout },
  { what: 'the owner LaunchAgents', folder: join(home, 'Library/LaunchAgents') },
  { what: 'the system LaunchDaemons', folder: '/Library/LaunchDaemons' },
  { what: 'the Seatbelt profile folder', folder: '/var/factory' },
  { what: 'the sudoers rules', folder: '/etc/sudoers.d' },
  { what: '/usr/local', folder: '/usr/local' },
  { what: 'Homebrew bin (on the agent and owner PATH)', folder: '/opt/homebrew/bin' },
];

/** Every local address the server may listen on: loopback (v4, v6), LAN, Tailscale. */
export function localAddresses(): string[] {
  const addresses = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (!entry.address.startsWith('fe80')) addresses.add(entry.address);
  }
  return [...addresses];
}

/** Parses `lsof -F cn` output: `c<command>` starts a process, `n<address>:<port>` names a socket. */
export function parseListeners(output: string): Listener[] {
  const listeners = new Map<string, Listener>();
  let command = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('c')) command = line.slice(1);
    if (!line.startsWith('n')) continue;
    const match = /^n(.*):(\d+)$/.exec(line);
    if (!match) continue;
    const address = match[1]!.replace(/^\[(.*)\]$/, '$1');
    const port = Number(match[2]);
    listeners.set(`${address}:${port}`, { command, address, port });
  }
  return [...listeners.values()];
}

/** Every TCP port the owner's processes listen on right now: Factory, Chrome, simulators, apps. */
export function ownerListeners(user = userInfo().username): Listener[] {
  const lsof = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-u', user, '-F', 'pcn'], { encoding: 'utf8' });
  return parseListeners(lsof.stdout ?? '');
}

/** One probe per address each listener answers on; a wildcard listener on every local address. */
export function portProbes(listeners: readonly Listener[], addresses = localAddresses()): PortProbe[] {
  const probes = new Map<string, PortProbe>();
  for (const { command, address, port } of listeners) {
    if (allowedPorts.has(port)) continue;
    for (const host of address === '*' ? addresses : [address]) {
      probes.set(`${host}:${port}`, { what: `${command} on ${host}:${port}`, host, port });
    }
  }
  return [...probes.values()];
}
