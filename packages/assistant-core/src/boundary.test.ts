/**
 * ADR-0051's boundary: the assistant reaches Factory only through its MCP, so its packages import
 * none of Factory's insides — `core`, `work-items`, `session`, `harness-*`, `integrations` (nor
 * `store`, which brings `core` with it). Allowed: `auth`, `http` (and its `access`),
 * `playground-ui`, `notifications`; the encryption module comes in as a port.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, '..', '..');

const FORBIDDEN = [
  /^@factory\/core(\/|$)/,
  /^@factory\/work-items(\/|$)/,
  /^@factory\/session(\/|$)/,
  /^@factory\/harness(-[a-z-]+)?(\/|$)/,
  /^@factory\/integrations?(-[a-z-]+)?(\/|$)/,
  /^@factory\/store(\/|$)/,
  /^@factory\/runtime(\/|$)/,
  /^@factory\/api(\/|$)/,
  /^@factory\/server(\/|$)/,
  /^@factory\/mcp(\/|$)/,
];
/** What a runtime dependency may be, among Factory's own packages. Tests may also use the auth provider. */
const ALLOWED_RUNTIME = new Set(['@factory/http', '@factory/access', '@factory/auth', '@factory/notifications', '@mastra/playground-ui']);
const ALLOWED_DEV = new Set([...ALLOWED_RUNTIME, '@factory/auth-better-auth']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map(match => match[1]!);
}

describe.each(['assistant-core', 'assistant-ui'])('%s', name => {
  const root = join(packagesDir, name);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it('depends on none of Factory’s insides', () => {
    const runtime = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
    expect(runtime.filter(dep => dep.startsWith('@factory/') && !ALLOWED_RUNTIME.has(dep))).toEqual([]);
    const dev = Object.keys(manifest.devDependencies ?? {});
    expect(dev.filter(dep => dep.startsWith('@factory/') && !ALLOWED_DEV.has(dep))).toEqual([]);
  });

  it('imports none of them in its sources', () => {
    const offending = sources(join(root, 'src')).flatMap(file =>
      imports(file)
        .filter(specifier => FORBIDDEN.some(pattern => pattern.test(specifier)))
        .map(specifier => `${file.slice(root.length + 1)} → ${specifier}`),
    );
    expect(offending).toEqual([]);
  });

  it('imports only its own declared @factory packages', () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const undeclared = sources(join(root, 'src')).flatMap(file =>
      imports(file)
        .filter(specifier => specifier.startsWith('@factory/'))
        .map(specifier => specifier.split('/').slice(0, 2).join('/'))
        .filter(pkg => !declared.has(pkg)),
    );
    expect(undeclared).toEqual([]);
  });
});
