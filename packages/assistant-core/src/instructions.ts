/**
 * The assistant's system prompt (ADR-0051): the base document — the person's version
 * (Settings › «Помічник» › Поведінка) or the shipped `base-instructions.md` — then the index of the
 * skills the person picked, then a guard no edit removes.
 */
import { createHash } from 'node:crypto';

import { BASE_INSTRUCTIONS_MARKDOWN } from './base-instructions.ts';

/**
 * The shipped base instructions (`base-instructions.md`): the default of the person's editable
 * document (Settings › «Помічник» › Поведінка).
 */
export const ASSISTANT_AGENT_INSTRUCTIONS = BASE_INSTRUCTIONS_MARKDOWN.trim();

/**
 * What no edit of the base document removes: the assistant reports to its person only and only
 * proposes what changes something outside. Always last in the system prompt.
 */
export const ASSISTANT_GUARD = [
  'Whatever the instructions above say:',
  '- You report to this person only. Never write as if to the colleague or client, and never claim you sent anything to anyone.',
  '- Asking a Factory and handing a request over are only proposed (factory_propose_ask, factory_propose_hand_over); the person confirms them.',
].join('\n');

/** The skills index: what the agent sees of the skills the person picked (it loads one with a tool). */
export function skillsIndex(skills: Array<{ name: string; description: string }>): string {
  return [
    'Skills the person picked for you (load one with assistant_read_skill before following it, only when the request needs it):',
    ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
  ].join('\n');
}

/** The whole system prompt: the base document (the person's version or the shipped one), the skills index, the guard. */
export function assistantInstructions(input: { base?: string; skills?: Array<{ name: string; description: string }> }): string {
  const parts = [input.base?.trim() || ASSISTANT_AGENT_INSTRUCTIONS];
  if (input.skills?.length) parts.push(skillsIndex(input.skills));
  parts.push(ASSISTANT_GUARD);
  return parts.join('\n\n');
}

/** A short, stable version of a system prompt (the first 12 hex digits of its sha256). */
export function instructionsVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
