import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import { createTool } from '@mastra/core/tools';
import type { Tool } from '@mastra/core/tools';
import { z } from 'zod';

/** Skill names are directory names; anything that could walk out of the skills directory is not one. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A reference file is text an agent reads; anything bigger is not one. */
const MAX_BYTES = 512 * 1024;

const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Reads one file of a Factory skill: `<directory>/<skillName>/<path>`, from the
 * first skills directory that has the skill. The path must stay inside the
 * skill's own folder, also after symlinks are resolved; anything else is
 * refused with a message, never read.
 */
export async function readSkillFile(
  directories: readonly string[],
  input: { skillName: string; path: string; startLine?: number; endLine?: number },
): Promise<{ skillName: string; path: string; content: string; totalLines: number }> {
  const skillName = input.skillName.trim();
  if (!SKILL_NAME_RE.test(skillName)) throw new Error(`"${input.skillName}" is not a skill name.`);
  const requested = input.path.trim().replace(/^\.\/+/, '');
  if (!requested || isAbsolute(requested)) throw new Error('The path must be relative to the skill folder.');
  const cleaned = normalize(requested);
  if (cleaned === '..' || cleaned.startsWith(`..${sep}`) || cleaned.split(sep).includes('..')) {
    throw new Error('The path must stay inside the skill folder.');
  }
  for (const directory of directories) {
    const skillRoot = join(directory, skillName);
    let root: string;
    try {
      root = await realpath(skillRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let file: string;
    try {
      file = await realpath(join(root, cleaned));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Skill "${skillName}" has no file "${requested}".`);
      }
      throw error;
    }
    if (!inside(root, file)) throw new Error('The path must stay inside the skill folder.');
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`"${requested}" in skill "${skillName}" is not a file.`);
    if (info.size > MAX_BYTES) throw new Error(`"${requested}" in skill "${skillName}" is too large to read.`);
    const lines = (await readFile(file, 'utf8')).split('\n');
    const start = Math.max(1, Math.floor(input.startLine ?? 1));
    const end = Math.min(lines.length, Math.floor(input.endLine ?? lines.length));
    return { skillName, path: requested, content: lines.slice(start - 1, end).join('\n'), totalLines: lines.length };
  }
  throw new Error(`There is no skill "${skillName}".`);
}

/**
 * `skill_read` for a Claude Code session, with the arguments a Mastra
 * session's has: the skill's kickoff carries only its SKILL.md, so this is how
 * the agent reads the skill's references and templates. Read-only, and only
 * inside the Factory's skills directories.
 */
export function createClaudeSkillReadTool(directories: readonly string[]): Tool<any, any, any, any> {
  return createTool({
    id: 'skill_read',
    description:
      'Read a file from a Factory skill folder (references, templates). The path is relative to the skill root, e.g. "references/docs-layout.md".',
    inputSchema: z.object({
      skillName: z.string().describe('The skill name, e.g. "product-enrich".'),
      path: z.string().describe('Path to the file relative to the skill root, e.g. "references/docs-layout.md".'),
      startLine: z.number().optional().describe('Starting line number (1-indexed).'),
      endLine: z.number().optional().describe('Ending line number (1-indexed, inclusive).'),
    }),
    execute: async input => readSkillFile(directories, input),
  }) as Tool<any, any, any, any>;
}
