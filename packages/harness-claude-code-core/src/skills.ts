import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentSkill } from '@factory/harness';

/** Skill names are directory names; anything that could walk out of the skills directory is not one. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A flat `key: value` frontmatter reader: the only keys read here are scalars. */
export function parseSkillFile(source: string): { frontmatter: Record<string, string>; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: source.trim() };
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    frontmatter[pair[1]!] = (pair[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { frontmatter, body: (match[2] ?? '').trim() };
}

/** Reads `<dir>/<name>/SKILL.md` from the first directory that has it. */
export async function readSkill(directories: string[], name: string): Promise<AgentSkill | undefined> {
  if (!SKILL_NAME_RE.test(name)) return undefined;
  for (const directory of directories) {
    let source: string;
    try {
      source = await readFile(join(directory, name, 'SKILL.md'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const { frontmatter, body } = parseSkillFile(source);
    return {
      name: frontmatter.name || name,
      userInvocable: frontmatter['user-invocable']?.toLowerCase() !== 'false',
      // Claude Code activates a skill by reading its instructions; the body is exactly that.
      activation: body,
    };
  }
  return undefined;
}
