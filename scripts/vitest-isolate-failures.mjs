#!/usr/bin/env node
// Runs a vitest suite, then re-runs every failed test file on its own.
//
// Some UI suites (MSW + React Query timing) fail only when hundreds of files
// compete for the CPU, in v3 as well: a different test each run, and every one
// passes alone. In-run retries share the same overloaded worker, so they do not
// help. A file fails the run only if it also fails when run by itself.
//
// Usage (from a package dir): node ../../scripts/vitest-isolate-failures.mjs [vitest args...]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const vitest = join(process.cwd(), 'node_modules', '.bin', 'vitest');
const report = join(mkdtempSync(join(tmpdir(), 'vitest-isolate-')), 'report.json');
const extra = process.argv.slice(2);

const full = spawnSync(
  vitest,
  ['run', ...extra, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`],
  { stdio: 'inherit' },
);
if (full.status === 0) process.exit(0);

let failedFiles;
try {
  const results = JSON.parse(readFileSync(report, 'utf8'));
  failedFiles = results.testResults.filter(file => file.status === 'failed').map(file => file.name);
} catch {
  // No report means vitest itself failed (config, syntax): that is a real failure.
  process.exit(full.status ?? 1);
}
if (failedFiles.length === 0) process.exit(full.status ?? 1);

console.log(`\n[isolate] ${failedFiles.length} file(s) failed under load; re-running each on its own\n`);
const stillFailing = [];
for (const file of failedFiles) {
  const alone = spawnSync(vitest, ['run', ...extra, relative(process.cwd(), file)], { stdio: 'inherit' });
  console.log(`[isolate] ${alone.status === 0 ? 'passes alone' : 'FAILS alone'}: ${relative(process.cwd(), file)}`);
  if (alone.status !== 0) stillFailing.push(file);
}
process.exit(stillFailing.length === 0 ? 0 : 1);
