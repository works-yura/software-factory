import type { AgentHarness, AgentNotificationInput, AgentNotificationOptions, AgentNotificationResult, AgentRunContext } from '@factory/harness';

export interface SkillInvocationInput {
  sessionId: string;
  name: string;
  arguments?: string;
}

export interface SkillSession {
  sendMessage(input: { content: string; requestContext?: AgentRunContext }): Promise<unknown>;
  sendNotificationSignal(
    input: AgentNotificationInput,
    options?: AgentNotificationOptions,
  ): Promise<AgentNotificationResult>;
}

type SkillHarness = Pick<AgentHarness, 'getSession' | 'findSkill'>;

export class SkillInvocationError extends Error {
  readonly code: 'session_not_found' | 'skill_not_found';

  constructor(code: SkillInvocationError['code'], message: string) {
    super(message);
    this.name = 'SkillInvocationError';
    this.code = code;
  }
}

async function requireSkill(harness: SkillHarness, input: SkillInvocationInput) {
  const session = await harness.getSession(input.sessionId);
  if (!session) throw new SkillInvocationError('session_not_found', 'Agent session not found.');
  const skill = await harness.findSkill(session, input.name);
  if (!skill || !skill.userInvocable) {
    throw new SkillInvocationError('skill_not_found', `Skill not found: ${input.name}.`);
  }
  return { session, skill };
}

function escapeSkillBoundary(value: string): string {
  return value.replaceAll('</skill>', '&lt;/skill&gt;');
}

/** Kicks a run off from a plain prompt, for runs that activate no skill. */
export async function resolvePromptInvocation(
  harness: Pick<AgentHarness, 'getSession'>,
  input: { sessionId: string; prompt: string },
): Promise<{ session: SkillSession; message: string }> {
  const session = await harness.getSession(input.sessionId);
  if (!session) throw new SkillInvocationError('session_not_found', 'Agent session not found.');
  return { session, message: input.prompt };
}

export async function resolveSkillInvocation(
  harness: SkillHarness,
  input: SkillInvocationInput,
): Promise<{ session: SkillSession; skillName: string; message: string }> {
  const { session, skill } = await requireSkill(harness, input);

  const args = input.arguments?.trim();
  const content = `${skill.activation}${args ? `\n\nARGUMENTS: ${args}` : ''}`.trim();
  return {
    session,
    skillName: skill.name,
    message: `<skill name="${skill.name}">\n${escapeSkillBoundary(content)}\n</skill>`,
  };
}

/**
 * Same-stage re-entry: the skill is already active in the card's live session.
 * Resolve a compact continuation that references the skill by name and carries
 * only the fresh arguments, instead of re-pasting the whole skill document. If
 * the skill body was compacted out of context, the agent can re-open it with the
 * skill tool.
 */
export async function resolveSkillResumeInvocation(
  harness: SkillHarness,
  input: SkillInvocationInput,
): Promise<{ session: SkillSession; skillName: string; message: string }> {
  const { session, skill } = await requireSkill(harness, input);

  const args = input.arguments?.trim();
  const content = [
    `Resume the active ${skill.name} session — it is already open in this thread; continue it rather than restarting.`,
    `Re-open the ${skill.name} skill with the skill tool if its instructions are no longer in context.`,
    ...(args ? [`ARGUMENTS: ${args}`] : []),
  ].join('\n');
  return {
    session,
    skillName: skill.name,
    message: `<skill name="${skill.name}">\n${escapeSkillBoundary(content)}\n</skill>`,
  };
}

export async function dispatchSkillInvocation(
  harness: SkillHarness,
  input: SkillInvocationInput,
  requestContext?: AgentRunContext,
): Promise<{ skillName: string; message: string }> {
  const resolved = await resolveSkillInvocation(harness, input);
  await resolved.session.sendMessage({ content: resolved.message, ...(requestContext ? { requestContext } : {}) });
  return { skillName: resolved.skillName, message: resolved.message };
}
