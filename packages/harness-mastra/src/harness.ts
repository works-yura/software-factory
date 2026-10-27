import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController, Session } from '@mastra/core/agent-controller';
import { RequestContext } from '@mastra/core/request-context';
import { formatSkillActivation } from '@mastra/core/workspace';

import type { AgentHarness, AgentRunContextInput, AgentSession, AgentSkill } from '@factory/harness';

import { REVIEW_ONLY_FACTORY_SKILLS, rescanFactorySkills } from './workspace.ts';

type MastraFactoryController = Pick<AgentController<MastraCodeState>, 'getSession' | 'listActiveThreadRuns'>;
type MastraSession = Session<MastraCodeState>;

/** Sessions this harness hands out are Mastra sessions; the runtime only sees the contract. */
function mastraSession(session: AgentSession): MastraSession {
  return session as unknown as MastraSession;
}

/**
 * A Mastra session as the contract sees it. Mastra sessions emit a superset of
 * the contract's events, which the runtime ignores, so the shapes line up apart
 * from the wider event union.
 */
export function asAgentSession(session: MastraSession): AgentSession {
  return session as unknown as AgentSession;
}

async function findMastraSkill(session: MastraSession, name: string) {
  const skills = session.getWorkspace()?.skills;
  if (!skills) return undefined;
  await skills.maybeRefresh();
  const skill = await skills.get(name);
  if (skill || !REVIEW_ONLY_FACTORY_SKILLS.has(name)) return skill;
  // The cache may predate the review binding this run was just given.
  try {
    await rescanFactorySkills(skills);
  } catch {
    return undefined;
  }
  return skills.get(name);
}

/**
 * The Mastra harness: Factory sessions run on Mastra Code's AgentController,
 * whose sessions already speak the contract's session surface.
 */
export function createMastraHarness(controller: MastraFactoryController): AgentHarness {
  return {
    getSession: async sessionId => {
      const session = await controller.getSession(sessionId);
      return session ? asAgentSession(session) : undefined;
    },
    listActiveThreadRuns: () => controller.listActiveThreadRuns(),

    // What Factory tools and processors read while the run executes: the caller,
    // and the session's state, identity, model and workspace.
    runContext(agentSession: AgentSession, input: AgentRunContextInput) {
      const session = mastraSession(agentSession);
      const requestContext = new RequestContext();
      requestContext.set('user', { workosId: input.userId, organizationId: input.orgId });
      requestContext.set('controller', {
        state: session.state.get(),
        getState: () => session.state.get(),
        threadId: input.threadId,
        resourceId: input.resourceId,
        session: {
          id: session.identity.getId(),
          ownerId: session.identity.getOwnerId(),
          modelId: session.model.get() ?? '',
        },
        workspace: session.getWorkspace(),
      });
      return requestContext;
    },

    async findSkill(agentSession: AgentSession, name: string): Promise<AgentSkill | undefined> {
      const skill = await findMastraSkill(mastraSession(agentSession), name);
      if (!skill) return undefined;
      return {
        name: skill.name,
        userInvocable: skill['user-invocable'] !== false,
        activation: formatSkillActivation(skill),
      };
    },
  };
}
