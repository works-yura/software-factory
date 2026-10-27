import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const locales = join(here, 'locales');
const uiRoot = join(here, '..');

const PLURAL = /_(zero|one|two|few|many|other)$/;

function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function catalog(language: string, namespace: string): Set<string> {
  const raw = JSON.parse(readFileSync(join(locales, language, `${namespace}.json`), 'utf8'));
  return new Set(flatten(raw).map(key => key.replace(PLURAL, '')));
}

const languages = readdirSync(locales);
const namespaces = readdirSync(join(locales, 'en')).map(file => file.replace(/\.json$/, ''));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('translation catalogs', () => {
  it.each(languages.filter(language => language !== 'en'))('%s has exactly the English keys', language => {
    for (const namespace of namespaces) {
      const english = catalog('en', namespace);
      const other = catalog(language, namespace);
      expect([...english].filter(key => !other.has(key)), `${language}/${namespace} missing`).toEqual([]);
      expect([...other].filter(key => !english.has(key)), `${language}/${namespace} extra`).toEqual([]);
    }
  });

  it('every translator key used in the UI exists in the English catalog', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(uiRoot)) {
      const text = readFileSync(file, 'utf8');
      for (const binding of text.matchAll(/const (\w+) = translator\('([\w-]+)'\)/g)) {
        const [, name, namespace] = binding as unknown as [string, string, string];
        const keys = catalog('en', namespace);
        for (const call of text.matchAll(new RegExp(`\\b${name}\\('([^']+)'`, 'g'))) {
          const key = (call[1] as string).replace(PLURAL, '');
          if (!keys.has(key)) missing.push(`${file.slice(uiRoot.length + 1)}: ${namespace}:${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
