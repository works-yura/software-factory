import * as NodePath from 'node:path';

import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from './DeviceToolchain.ts';
import type { ProcessRunner, ProcessRunOutput } from './runtime.ts';

export const deviceToolMaintenanceScript = String.raw`
const maintenanceFs = require('node:fs');
const maintenancePath = require('node:path');
const maintenanceAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
async function withToolMaintenance(root, operation) {
  maintenanceFs.mkdirSync(root, { recursive: true });
  const lock = maintenancePath.join(root, '.maintenance-lock');
  const nonce = require('node:crypto').randomUUID();
  const ownerFile = process.pid + '.' + nonce + '.json';
  const candidate = lock + '.' + nonce;
  const holder = { pid: process.pid };
  const deadline = Date.now() + 30000;
  const removeEmptyLock = () => {
    try { maintenanceFs.rmdirSync(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code)) throw error; }
  };
  maintenanceFs.mkdirSync(candidate);
  try {
    maintenanceFs.writeFileSync(maintenancePath.join(candidate, ownerFile), JSON.stringify(holder));
    while (true) {
      try {
        // Publish a populated directory atomically; rename cannot replace another populated lock.
        maintenanceFs.renameSync(candidate, lock);
        break;
      }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let files = [];
        try { files = maintenanceFs.readdirSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (files.length === 1) {
          const previousFile = maintenancePath.join(lock, files[0]);
          let previous;
          try { previous = JSON.parse(maintenanceFs.readFileSync(previousFile, 'utf8')); } catch {}
          if (Number.isSafeInteger(previous?.pid) && previous.pid > 0 && !maintenanceAlive(previous.pid)) {
            // The unique filename belongs only to that owner. Never unlink a replacement owner's file.
            try { maintenanceFs.unlinkSync(previousFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
        // A concurrent acquirer publishes its owner file with the directory, so this cannot remove it.
        removeEmptyLock();
        if (Date.now() >= deadline) throw Error('Device tool maintenance is locked. Retry when the other operation finishes.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return operation(); }
    finally {
      maintenanceFs.unlinkSync(maintenancePath.join(lock, ownerFile));
      removeEmptyLock();
    }
  } finally {
    maintenanceFs.rmSync(candidate, { recursive: true, force: true });
  }
}
function pruneTools(root, specs, flat) {
  return withToolMaintenance(root, () => {
    // Keep installs used by any running helper, including older releases.
    const scan = process.platform === 'win32'
      ? require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'], { encoding: 'utf8', timeout: 10000 })
      : require('node:child_process').spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 10000 });
    if (scan.status !== 0 || !scan.stdout) return;
    for (const [name, required] of specs) {
      const parent = flat ? root : maintenancePath.join(root, name);
      let names;
      try { names = maintenanceFs.readdirSync(parent); } catch { continue; }
      const completed = [];
      for (const item of names) {
        const version = flat ? (item.startsWith(name + '@') ? item.slice(name.length + 1) : '') : item;
        if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) continue;
        const directory = maintenancePath.join(parent, item);
        try {
          if (!maintenanceFs.lstatSync(directory).isDirectory()) continue;
          if (maintenanceFs.readFileSync(maintenancePath.join(directory, '.install-complete'), 'utf8').trim() !== version) continue;
          completed.push({ version, directory, modified: maintenanceFs.statSync(maintenancePath.join(directory, '.install-complete')).mtimeMs });
        } catch {}
      }
      // Never prune until the required install has completed. Retain the last other successful install.
      if (!completed.some(value => value.version === required)) continue;
      const previous = completed.filter(value => value.version !== required).sort((a, b) => b.modified - a.modified || b.version.localeCompare(a.version, 'en', { numeric: true }))[0]?.version;
      for (const { version, directory } of completed) {
        if (version === required || version === previous || scan.stdout.includes(directory + maintenancePath.sep)) continue;
        maintenanceFs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });
}
`;

export class DeviceToolMaintenanceError extends Error {
  readonly _tag = 'DeviceToolMaintenanceError';
  readonly operation: 'prune';
  readonly tool: 'hub' | 'agent';
  readonly exitCode: number | null;
  constructor(fields: { operation: 'prune'; tool: 'hub' | 'agent'; exitCode: number | null; cause: unknown }) {
    super(`Device tool ${fields.operation} failed for ${fields.tool} (exit code ${fields.exitCode ?? 'unknown'}).`, {
      cause: fields.cause,
    });
    this.operation = fields.operation;
    this.tool = fields.tool;
    this.exitCode = fields.exitCode;
  }
}

const runMaintenance = async (
  runner: ProcessRunner,
  nodePath: string,
  script: string,
  operation: 'prune',
  tool: 'hub' | 'agent',
) => {
  const result: ProcessRunOutput = await runner.run({
    command: nodePath,
    args: [
      '-e',
      deviceToolMaintenanceScript +
        '\n' +
        script +
        '.catch(error => { console.error(error.message); process.exitCode = 1; });',
    ],
  });
  if (result.code !== 0) throw new DeviceToolMaintenanceError({ operation, tool, exitCode: result.code, cause: result });
};

/** Removes completed installs that are neither required, the previous one, nor in use. */
export const pruneLocalDeviceTools = (runner: ProcessRunner, baseDir: string, nodePath: string, tool: 'hub' | 'agent') =>
  runMaintenance(
    runner,
    nodePath,
    `pruneTools(${JSON.stringify(NodePath.join(baseDir, 'tools'))}, ${JSON.stringify(tool === 'hub' ? [['expo-device-hub', DEVICE_HUB_VERSION]] : [['agent-device', AGENT_DEVICE_VERSION]])}, false)`,
    'prune',
    tool,
  );
