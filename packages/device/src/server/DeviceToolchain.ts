import * as NodePath from 'node:path';

import type { DeviceToolVersions } from '../contracts.ts';
// npm exposes entry files before extraction completes; their presence does not prove a usable tree.
import DEVICE_TOOL_VERSIONS from './deviceToolVersions.json' with { type: 'json' };
import { type DeviceFs, fileExists, isNotFound, type ProcessRunner, Semaphore } from './runtime.ts';

const DEVICE_HUB_PACKAGE = 'expo-device-hub';
export const DEVICE_HUB_VERSION = DEVICE_TOOL_VERSIONS[DEVICE_HUB_PACKAGE];
const AGENT_DEVICE_PACKAGE = 'agent-device';
export const AGENT_DEVICE_VERSION = DEVICE_TOOL_VERSIONS[AGENT_DEVICE_PACKAGE];

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const installLock = new Semaphore(1);

export interface DeviceToolPaths {
  readonly installDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export interface DeviceToolchainPaths {
  readonly hub: DeviceToolPaths;
  readonly agentDevice: DeviceToolPaths;
}

export class DeviceToolchainInstallError extends Error {
  readonly _tag = 'DeviceToolchainInstallError';
  readonly tool: string;
  readonly step: string;
  readonly exitCode: number | undefined;
  constructor(fields: { tool: string; step: string; exitCode?: number; cause?: unknown }) {
    const suffix = fields.exitCode === undefined ? '' : ` (exit code ${fields.exitCode})`;
    super(
      `Installing ${fields.tool} failed while ${fields.step}${suffix}.`,
      fields.cause === undefined ? undefined : { cause: fields.cause },
    );
    this.tool = fields.tool;
    this.step = fields.step;
    this.exitCode = fields.exitCode;
  }
}

/** What installing and inspecting tools needs from the host. */
export interface DeviceToolchainRuntime {
  readonly fs: DeviceFs;
  readonly runner: ProcessRunner;
}

interface ToolSpec {
  readonly name: string;
  readonly version: string;
  readonly entry: ReadonlyArray<string>;
}

const HUB_SPEC: ToolSpec = {
  name: DEVICE_HUB_PACKAGE,
  version: DEVICE_HUB_VERSION,
  entry: ['dist', 'server', 'cli.mjs'],
};

const AGENT_DEVICE_SPEC: ToolSpec = {
  name: AGENT_DEVICE_PACKAGE,
  version: AGENT_DEVICE_VERSION,
  entry: ['bin', 'agent-device.mjs'],
};

const toolPaths = (baseDir: string, spec: ToolSpec): DeviceToolPaths => {
  const installDir = NodePath.join(baseDir, 'tools', spec.name, spec.version);
  return {
    installDir,
    entryPath: NodePath.join(installDir, 'node_modules', spec.name, ...spec.entry),
    sentinelPath: NodePath.join(installDir, '.install-complete'),
  };
};

export const deviceToolchainPaths = (baseDir: string): DeviceToolchainPaths => ({
  hub: toolPaths(baseDir, HUB_SPEC),
  agentDevice: toolPaths(baseDir, AGENT_DEVICE_SPEC),
});

export const agentDeviceStateDir = (stateDir: string): string => NodePath.join(stateDir, 'device', 'agent-device');

const isInstalled = async (fs: DeviceFs, paths: DeviceToolPaths, version: string) => {
  try {
    const [entryExists, sentinel] = await Promise.all([
      fileExists(fs, paths.entryPath),
      fs.readFile(paths.sentinelPath, 'utf8').catch(() => null),
    ]);
    return entryExists && sentinel !== null && sentinel.trim() === version;
  } catch {
    return false;
  }
};

const installTool = async (runtime: DeviceToolchainRuntime, spec: ToolSpec, paths: DeviceToolPaths) => {
  const { fs, runner } = runtime;
  const fail = (step: string) => (cause: unknown): never => {
    throw new DeviceToolchainInstallError({ tool: spec.name, step, cause });
  };

  if (await isInstalled(fs, paths, spec.version)) return paths;

  const parentDir = NodePath.dirname(paths.installDir);
  await fs.rm(paths.installDir, { recursive: true, force: true }).catch(fail('removing an incomplete install'));
  await fs.mkdir(parentDir, { recursive: true }).catch(fail('preparing the install directory'));
  const stagingDir = await fs
    .mkdtemp(NodePath.join(parentDir, '.staging-'))
    .catch(fail('preparing the install directory'));

  try {
    const installArgs = ['install', '--prefix', stagingDir, '--no-fund', '--no-audit', `${spec.name}@${spec.version}`];
    const result = await runner
      .run({ command: 'npm', args: installArgs, timeoutMs: INSTALL_TIMEOUT_MS })
      .catch((error: unknown) =>
        (error as { _tag?: string; code?: string })._tag === 'ProcessSpawnError' &&
        (error as { code?: string }).code === 'ENOENT'
          ? runner.run({
              command: 'pnpm',
              args: ['--package=npm@11', 'dlx', 'npm', ...installArgs],
              timeoutMs: INSTALL_TIMEOUT_MS,
            })
          : Promise.reject(error),
      )
      .catch(fail('running npm install'));
    if (result.code !== 0) {
      throw new DeviceToolchainInstallError({
        tool: spec.name,
        step: 'running npm install',
        exitCode: Number(result.code),
        cause: result,
      });
    }
    const stagedEntry = NodePath.join(stagingDir, 'node_modules', spec.name, ...spec.entry);
    if (!(await fileExists(fs, stagedEntry))) {
      throw new DeviceToolchainInstallError({ tool: spec.name, step: 'verifying the installed entry point' });
    }
    await fs
      .writeFile(NodePath.join(stagingDir, '.install-complete'), `${spec.version}\n`)
      .catch(fail('recording the completed install'));
    await fs.rename(stagingDir, paths.installDir).catch(async (cause: unknown) => {
      if (!(await isInstalled(fs, paths, spec.version))) fail('publishing the install')(cause);
    });
    return paths;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const ensureTool = (runtime: DeviceToolchainRuntime, baseDir: string, spec: ToolSpec) =>
  installLock.withPermit(() => installTool(runtime, spec, toolPaths(baseDir, spec)));

/** Rejects with `DeviceToolchainInstallError`. */
export const ensureDeviceHub = (runtime: DeviceToolchainRuntime, baseDir: string) => ensureTool(runtime, baseDir, HUB_SPEC);

/** Rejects with `DeviceToolchainInstallError`. */
export const ensureAgentDevice = (runtime: DeviceToolchainRuntime, baseDir: string) =>
  ensureTool(runtime, baseDir, AGENT_DEVICE_SPEC);

export const isDeviceHubInstalled = (fs: DeviceFs, baseDir: string) =>
  isInstalled(fs, toolPaths(baseDir, HUB_SPEC), HUB_SPEC.version);

export const isAgentDeviceInstalled = (fs: DeviceFs, baseDir: string) =>
  isInstalled(fs, toolPaths(baseDir, AGENT_DEVICE_SPEC), AGENT_DEVICE_SPEC.version);

/** Entry of the first installed agent-device among `versions`; never installs. */
export const installedAgentDeviceEntry = async (fs: DeviceFs, baseDir: string, versions: ReadonlyArray<string>) => {
  for (const version of versions) {
    const paths = toolPaths(baseDir, { ...AGENT_DEVICE_SPEC, version });
    if (await isInstalled(fs, paths, version)) return paths.entryPath;
  }
  return null;
};

/** Installed and running versions; undefined when the inventory cannot be read. */
export const deviceToolVersions = async (
  fs: DeviceFs,
  baseDir: string,
  running: { hub?: string; agent?: string } = {},
): Promise<DeviceToolVersions | undefined> => {
  const inspect = async (spec: ToolSpec) => {
    const directory = NodePath.join(baseDir, 'tools', spec.name);
    const names = await fs.readdir(directory).catch((error: unknown) => {
      if (isNotFound(error)) return [] as string[];
      throw error;
    });
    const versions: string[] = [];
    for (const version of names) {
      if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) continue;
      const paths = toolPaths(baseDir, { ...spec, version });
      const sentinel = await fs.readFile(paths.sentinelPath, 'utf8').catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (sentinel?.trim() === version && (await fileExists(fs, paths.entryPath))) versions.push(version);
    }
    return {
      requiredVersion: spec.version,
      installedVersions: versions.sort(),
      runningVersion: (spec.name === DEVICE_HUB_PACKAGE ? running.hub : running.agent) ?? null,
    };
  };
  try {
    return { hub: await inspect(HUB_SPEC), agent: await inspect(AGENT_DEVICE_SPEC) };
  } catch {
    return undefined;
  }
};
