#!/usr/bin/env node
// Runs every workspace package's `test` script one package at a time, with
// guards so a hung suite can never block the run silently:
//
// - a wall-clock limit per package (FACTORY_TEST_PACKAGE_TIMEOUT_MS, default 15 min);
// - a stall limit: no output for FACTORY_TEST_STALL_MS (default 5 min);
// - no bail: every package runs, and the summary lists each failure.
//
// Progress lines start with `[tests]`, so a watcher can follow the run:
//   [tests] 3/26 start packages/runtime
//   [tests] 3/26 ok packages/runtime 41s
//   [tests] 4/26 STALLED packages/api (no output for 300s)
//
// Usage (from the repo root): node scripts/run-tests.mjs [package-dir-filter]

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const packageTimeoutMs = Number(process.env.FACTORY_TEST_PACKAGE_TIMEOUT_MS) || 15 * 60_000;
const stallMs = Number(process.env.FACTORY_TEST_STALL_MS) || 5 * 60_000;
const filter = process.argv[2];

function workspaceDirs() {
  const dirs = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const manifest = join(base, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
      if (scripts.test) dirs.push(join(base, name));
    }
  }
  return filter ? dirs.filter(dir => relative(root, dir).includes(filter)) : dirs;
}

function runPackage(dir) {
  return new Promise(resolve => {
    const started = Date.now();
    // Own process group, so a timeout kills vitest's workers too.
    const child = spawn('corepack', ['pnpm', 'run', 'test'], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let lastOutput = Date.now();
    let verdict;
    const onData = chunk => {
      lastOutput = Date.now();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = reason => {
      if (verdict) return;
      verdict = reason;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - started > packageTimeoutMs) kill(`TIMEOUT (over ${Math.round(packageTimeoutMs / 1000)}s)`);
      else if (now - lastOutput > stallMs) kill(`STALLED (no output for ${Math.round(stallMs / 1000)}s)`);
    }, 5_000);
    child.on('close', code => {
      clearInterval(watchdog);
      const seconds = Math.round((Date.now() - started) / 1000);
      resolve({ ok: !verdict && code === 0, verdict: verdict ?? (code === 0 ? 'ok' : `FAILED (exit ${code})`), seconds });
    });
  });
}

const dirs = workspaceDirs();
const results = [];
for (const [index, dir] of dirs.entries()) {
  const name = relative(root, dir);
  const step = `${index + 1}/${dirs.length}`;
  console.log(`[tests] ${step} start ${name}`);
  const result = await runPackage(dir);
  console.log(`[tests] ${step} ${result.verdict} ${name} ${result.seconds}s`);
  results.push({ name, ...result });
}

const failed = results.filter(result => !result.ok);
console.log(`\n[tests] summary: ${results.length - failed.length}/${results.length} packages passed`);
for (const result of results) console.log(`[tests]   ${result.ok ? 'ok    ' : 'FAILED'} ${result.name} ${result.seconds}s ${result.ok ? '' : result.verdict}`);
process.exit(failed.length === 0 ? 0 : 1);
