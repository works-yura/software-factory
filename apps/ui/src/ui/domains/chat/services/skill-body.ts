import type { SkillActivation } from '@mastra/playground-ui/domains/chat/messages/skill-activation';

// From upstream `parseSkillBody` (a5a9179daa, playground-ui skill-activation.ts),
// which @mastra/playground-ui 65.0.0 does not ship yet.
const WORK_ITEM_FEED_TAG = 'work-item-feed';
const ARGUMENTS_MARKER = '\n\nARGUMENTS: ';
const TRAILING_FEED_PATTERN = new RegExp(`\\n\\n<${WORK_ITEM_FEED_TAG}>\\s*([\\s\\S]*?)\\s*</${WORK_ITEM_FEED_TAG}>$`);

/**
 * Parses the contents of a typed `skill` signal (the skill name travels as a signal
 * attribute, so there is no envelope). A trailing work-item feed is split out.
 */
export function parseSkillBody(name: string, text: string): SkillActivation | undefined {
  if (!name) return undefined;
  const trimmed = text.trim();
  const feedMatch = TRAILING_FEED_PATTERN.exec(trimmed);
  const body = feedMatch ? trimmed.slice(0, feedMatch.index) : trimmed;
  return splitSkillBody(name, body, feedMatch?.[1]);
}

function splitSkillBody(name: string, body: string, feed: string | undefined): SkillActivation | undefined {
  if (!body.trim()) return undefined;

  const argIndex = body.lastIndexOf(ARGUMENTS_MARKER);
  const instructions = argIndex >= 0 ? body.slice(0, argIndex) : body;
  const args = argIndex >= 0 ? body.slice(argIndex + ARGUMENTS_MARKER.length).trim() : undefined;

  return { name, instructions, arguments: args || undefined, ...(feed !== undefined ? { feed } : {}) };
}
