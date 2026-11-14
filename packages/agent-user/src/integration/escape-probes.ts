/**
 * What an agent must never reach on the machine it shares with the owner: the owner's files and
 * logins, the Factory server (its code, releases, database, port), system places that run code
 * as someone else, and the owner's processes. Each probe names a target the server user can
 * reach, so the suite checks both sides: the server can, the agent cannot.
 */

import { networkInterfaces, homedir, tmpdir } from 'node:os';
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
  url: string;
}

const home = homedir();
/** The checkout this suite runs from (`packages/agent-user/src/integration` is four levels down). */
const checkout = resolve(import.meta.dirname, '../../../..');
/** Where deploys keep releases, `current` and the card folders. */
const deployRoot = process.env.FACTORY_AGENT_USER_TEST_DEPLOY_ROOT ?? '/Volumes/dot/Project/factory';
const ports = (process.env.FACTORY_AGENT_USER_TEST_PORTS ?? '5874,9222').split(',').map(port => port.trim()).filter(Boolean);

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

export const portProbes: readonly PortProbe[] = ports.flatMap(port =>
  localAddresses().map(address => {
    const host = address.includes(':') ? `[${address}]` : address;
    return { what: `port ${port} on ${address}`, url: `http://${host}:${port}/` };
  }),
);
