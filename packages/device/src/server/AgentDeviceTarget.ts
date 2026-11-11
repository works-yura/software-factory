import * as NodePath from 'node:path';

import { DeviceOperationError } from '../contracts.ts';
import type { AgentDaemonEndpoint } from './DeviceHost.ts';
import { type DeviceFs, HttpStatusError, shortHash, withTimeout } from './runtime.ts';

/**
 * A stable file per host lets forwarded endpoints change without retargeting
 * other commands. Hosts with a daemon per device get a file per device.
 */
export const agentDeviceConfigPath = (stateDir: string, hostId: string, deviceId?: string) =>
  NodePath.join(
    stateDir,
    'device',
    'hosts',
    `${shortHash(deviceId === undefined ? hostId : JSON.stringify([hostId, deviceId]))}.json`,
  );

export const agentDeviceSession = (threadId: string, hostId: string, deviceId: string) =>
  `t3-${shortHash(JSON.stringify([threadId, hostId, deviceId]))}`;

export const writeAgentDeviceConfig = async (
  fs: DeviceFs,
  file: string,
  endpoint: AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
) => {
  await fs.mkdir(NodePath.dirname(file), { recursive: true });
  const content = JSON.stringify({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
    ...(endpoint.stateDir === undefined ? {} : { stateDir: endpoint.stateDir }),
  });
  if ((await fs.readFile(file, 'utf8').catch(() => '')) === content) return;
  const directory = await fs.mkdtemp(NodePath.join(NodePath.dirname(file), '.endpoint-'));
  const temporary = NodePath.join(directory, 'endpoint.json');
  try {
    await fs.writeFile(temporary, '', { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

const isCloseResult = (value: unknown): boolean => {
  const body = value as { result?: { ok?: unknown }; error?: { data?: { code?: unknown } } } | null;
  return body?.result?.ok === true || body?.error?.data?.code === 'SESSION_NOT_FOUND';
};

/** Ends an agent-device session on a running daemon; an already-released session succeeds. */
export const releaseAgentDeviceSession =
  (http: typeof fetch, endpoint: AgentDaemonEndpoint) =>
  async (session: string): Promise<void> => {
    try {
      await withTimeout(15_000, async (signal) => {
        const url = `${endpoint.baseUrl}/rpc`;
        const response = await http(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: session,
            method: 'agent_device.command',
            params: { command: 'close', session, positionals: [], flags: {} },
          }),
          signal,
        });
        // agent-device reports an already-released session as HTTP 404.
        if (response.status !== 404 && !response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          throw new HttpStatusError(url, response.status);
        }
        const body: unknown = await response.json();
        if (!isCloseResult(body)) throw new Error('Unexpected agent-device close result');
      });
    } catch (cause) {
      throw new DeviceOperationError({ operation: 'close', reason: 'request_failed', cause });
    }
  };
