// Builds dist/ when it is missing or older than the sources. apps/ui consumes this package through dist/, so
// `pnpm check` (which runs workspace packages before their dependents) calls it before the app is type-checked.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = resolve(root, 'dist/.built');

const newest = (path) => {
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return readdirSync(path).reduce((latest, name) => Math.max(latest, newest(resolve(path, name))), 0);
};

const inputs = ['src', 'theme', 'package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.build.json'].map(name =>
  resolve(root, name),
);
const stale = !existsSync(stamp) || inputs.some(path => newest(path) > statSync(stamp).mtimeMs);

if (!stale) {
  console.log('@mastra/playground-ui: dist is up to date');
} else {
  console.log('@mastra/playground-ui: building dist');
  const vite = createRequire(import.meta.url).resolve('vite/bin/vite.js');
  execFileSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' });
}
