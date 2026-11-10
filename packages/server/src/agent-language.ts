import type { AgentLanguage, FactoryProject } from '@factory/store';

const LANGUAGE_NAMES: Record<AgentLanguage, string> = {
  uk: 'Ukrainian',
  en: 'English',
};

/**
 * The Factory's «Мова агентів» as one line of every agent session's system
 * prompt, on both harnesses: what the team reads is in that language; code
 * and anything a skill marks as the client's keeps its own.
 */
export function agentLanguageInstruction(language: AgentLanguage): string {
  return (
    `Write every message to the person, plans, handoffs, summaries and documents for the team in ${LANGUAGE_NAMES[language]}. ` +
    'Keep code, identifiers, file paths, commands, quoted source text and anything the skill says is for the client in its own language.'
  );
}

/**
 * A session's system prompt with its Factory's language line appended. The
 * caller reads the Factory each time it builds the prompt, so a changed setting
 * reaches the next prompt built for the session. A Factory that cannot be found
 * is an error, not a prompt without the line.
 */
export function withAgentLanguage(
  base: string | undefined,
  factoryProjectId: string,
  project: Pick<FactoryProject, 'agentLanguage'> | null | undefined,
): string {
  if (!project) throw new Error(`Factory ${factoryProjectId} was not found while building the agent's instructions.`);
  const line = agentLanguageInstruction(project.agentLanguage);
  return base ? `${base}\n\n${line}` : line;
}
