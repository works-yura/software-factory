import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The bundled skills run in every harness. A Claude Code session holds no
 * provider credentials or CLI login, so provider access goes through the
 * Factory's tools only, which both harnesses get.
 */
const skillsDir = join(__dirname, '..', '..', 'factory-skills');
const toolsSource = readFileSync(join(__dirname, '..', 'tools', 'source-control-tools.ts'), 'utf8');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

const files = markdownFiles(skillsDir).map(path => ({
  name: relative(skillsDir, path),
  lines: readFileSync(path, 'utf8').split('\n'),
}));

/** A line that only forbids a command names it without using it. */
const GUARD = /\b(never|do not|don't|not use|no )/i;
const CLI = /`(gh|glab) [a-z]|\bgh (pr|issue|api|repo|label|run|release) |\bglab mr |git push\b|--paginate\b|--jq\b|\bcurl /;

describe('bundled Factory skills', () => {
  it('reach the provider through Factory tools, never a CLI, a raw API call or git push', () => {
    const offending = files.flatMap(({ name, lines }) =>
      lines.flatMap((line, index) => (CLI.test(line) && !GUARD.test(line) ? [`${name}:${index + 1}: ${line.trim()}`] : [])),
    );
    expect(offending).toEqual([]);
  });

  it('name only source-control tools that exist', () => {
    const known = new Set([...toolsSource.matchAll(/id: '(source_control_[a-z_]+)'/g)].map(match => match[1]!));
    const unknown = files.flatMap(({ name, lines }) =>
      lines.flatMap((line, index) =>
        [...line.matchAll(/\bsource_control_[a-z_]+[a-z]\b/g)]
          .map(match => match[0])
          .filter(tool => !known.has(tool))
          .map(tool => `${name}:${index + 1}: ${tool}`),
      ),
    );
    expect(known.size).toBeGreaterThan(20);
    expect(unknown).toEqual([]);
  });

  it('carry nothing specific to the upstream Mastra repository', () => {
    const upstream = files.flatMap(({ name, lines }) =>
      lines.flatMap((line, index) =>
        /mastra-ai\/|weather-agent|@mastra\//.test(line) ? [`${name}:${index + 1}: ${line.trim()}`] : [],
      ),
    );
    expect(upstream).toEqual([]);
  });
});
