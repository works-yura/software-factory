import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { readSkillFile } from './skill-read.ts';

let local: string;
let bundled: string;
let outside: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-read-'));
  local = join(root, 'local');
  bundled = join(root, 'bundled');
  outside = join(root, 'secret.txt');
  await writeFile(outside, 'secret');
  await mkdir(join(bundled, 'product-enrich', 'references'), { recursive: true });
  await writeFile(join(bundled, 'product-enrich', 'SKILL.md'), '# enrich');
  await writeFile(join(bundled, 'product-enrich', 'references', 'docs-layout.md'), 'one\ntwo\nthree');
  await symlink(outside, join(bundled, 'product-enrich', 'references', 'escape.md'));
  await mkdir(join(local, 'product-enrich', 'references'), { recursive: true });
  await writeFile(join(local, 'product-enrich', 'references', 'docs-layout.md'), 'local copy');
});

describe('readSkillFile', () => {
  it('reads a reference from the first skills directory that has the skill', async () => {
    await expect(readSkillFile([bundled], { skillName: 'product-enrich', path: 'references/docs-layout.md' })).resolves.toMatchObject({
      content: 'one\ntwo\nthree',
      totalLines: 3,
    });
    await expect(readSkillFile([local, bundled], { skillName: 'product-enrich', path: './references/docs-layout.md' })).resolves.toMatchObject({
      content: 'local copy',
    });
  });

  it('reads a line range', async () => {
    await expect(
      readSkillFile([bundled], { skillName: 'product-enrich', path: 'references/docs-layout.md', startLine: 2, endLine: 2 }),
    ).resolves.toMatchObject({ content: 'two' });
  });

  it('refuses paths that leave the skill folder, also through a symlink', async () => {
    await expect(readSkillFile([bundled], { skillName: 'product-enrich', path: '../product-enrich/SKILL.md' })).rejects.toThrow(
      'inside the skill folder',
    );
    await expect(readSkillFile([bundled], { skillName: 'product-enrich', path: outside })).rejects.toThrow('relative');
    await expect(readSkillFile([bundled], { skillName: 'product-enrich', path: 'references/escape.md' })).rejects.toThrow(
      'inside the skill folder',
    );
    await expect(readSkillFile([bundled], { skillName: '../bundled', path: 'x' })).rejects.toThrow('not a skill name');
  });

  it('says when the skill or the file does not exist', async () => {
    await expect(readSkillFile([bundled], { skillName: 'nope', path: 'SKILL.md' })).rejects.toThrow('no skill "nope"');
    await expect(readSkillFile([bundled], { skillName: 'product-enrich', path: 'references/missing.md' })).rejects.toThrow(
      'has no file',
    );
  });
});
