import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSkill } from '@mastra/core/skills';
import { LocalSkillSource, Workspace } from '@mastra/core/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactorySkillSource } from './workspace.ts';

describe('app skills on the Factory skill mount', () => {
  let consumerRoot: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (consumerRoot) await rm(consumerRoot, { recursive: true, force: true });
  });

  it('loads MastraFactory({ skills }) code skills ahead of folder, bundled, and repository skills', async () => {
    consumerRoot = await mkdtemp(path.join(tmpdir(), 'factory-code-skills-'));
    const folderRoot = path.join(consumerRoot, 'factory-skills');
    const repoSkills = path.join(consumerRoot, 'repo', '.mastracode', 'skills');
    for (const [root, name, body] of [
      [folderRoot, 'release-notes', 'Folder release notes.'],
      [folderRoot, 'release-notes/references', ''],
      [repoSkills, 'release-notes', 'Repository release notes.'],
    ] as const) {
      await mkdir(path.join(root, name), { recursive: true });
      if (body) {
        await writeFile(path.join(root, name, 'SKILL.md'), `---\nname: release-notes\ndescription: d\n---\n${body}\n`);
      }
    }
    await writeFile(path.join(folderRoot, 'release-notes', 'references', 'folder-only.md'), 'folder');
    const codeSkills = [
      createSkill({
        name: 'release-notes',
        description: 'Draft release notes',
        instructions: 'Code release notes.',
        references: { 'style.md': 'Use short bullets.' },
      }),
      createSkill({ name: 'factory-plan', description: 'Our plan', instructions: 'Our planning rules.' }),
    ];
    const source = new FactorySkillSource(
      new LocalSkillSource({ basePath: consumerRoot }),
      [repoSkills],
      folderRoot,
      async () => false,
      codeSkills,
    );
    const mount = path.resolve(path.parse(consumerRoot).root, '__mastracode_factory_skills__');
    const workspace = new Workspace({ skillSource: source, skills: [mount, repoSkills] });

    await expect(workspace.skills?.get('release-notes')).resolves.toMatchObject({
      instructions: 'Code release notes.',
      references: ['style.md'],
    });
    await expect(workspace.skills?.get('factory-plan')).resolves.toMatchObject({ instructions: 'Our planning rules.' });
    // The code skill owns its directory: the folder copy's files never mix in.
    expect(await source.exists(path.join(mount, 'release-notes', 'references', 'folder-only.md'))).toBe(false);
    expect(String(await source.readFile(path.join(mount, 'release-notes', 'references', 'style.md')))).toBe(
      'Use short bullets.',
    );
    // The repository's same-named skill is hidden rather than colliding.
    expect((await source.readdir(repoSkills)).map(entry => entry.name)).not.toContain('release-notes');
    // Review-only skills stay hidden outside review sessions, code skills included.
    expect((await source.readdir(mount)).map(entry => entry.name)).not.toContain('factory-review');
  });
});
