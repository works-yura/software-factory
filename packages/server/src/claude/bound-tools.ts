import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import type { Tool } from '@mastra/core/tools';
import { z } from 'zod';

import type { BoardRegistry } from '@factory/core';
import { createFactoryTransitionTools } from '@factory/harness-mastra';
import type { SessionGit } from '@factory/harness-mastra';
import type { FactoryMcpToolScope } from '@factory/mcp';
import { repoDirUnder } from '@factory/sandbox';
import type { FactoryTransitionService } from '@factory/runtime';
import type { FactorySessionSourceLookup } from '@factory/session';
import type { WorkItemsStorage } from '@factory/store';

type AnyTool = Tool<any, any, any, any>;

/** The request context a bound Mastra run's tools read, rebuilt from a verified worker scope. */
export function boundRunRequestContext(scope: FactoryMcpToolScope): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set('user', { workosId: scope.userId, organizationId: scope.orgId });
  const state = { factoryProjectId: scope.factoryProjectId, factoryOrgId: scope.orgId };
  requestContext.set('controller', {
    sessionId: scope.sessionId,
    threadId: scope.threadId,
    resourceId: scope.resourceId,
    state,
    getState: () => state,
  });
  return requestContext;
}

/**
 * Re-mounts an agent tool for MCP: the inner tool reads its caller from the
 * request context and its idempotency from the agent's tool call id, neither
 * of which an MCP call carries, so each call gets the bound context and a
 * fresh call id.
 */
function asMcpTool(
  tool: AnyTool,
  requestContext: RequestContext,
  workspace?: () => Promise<{ sandbox: unknown } | undefined>,
): AnyTool {
  return createTool({
    id: tool.id,
    description: tool.description,
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    execute: async (input: unknown) => {
      if (!tool.execute) throw new Error(`Tool ${tool.id} cannot be executed.`);
      return tool.execute(input, {
        requestContext,
        ...(workspace ? { workspace: await workspace() } : {}),
        agent: { agentId: 'claude-code', toolCallId: randomUUID(), messages: [], suspend: async () => {} },
      } as never);
    },
  }) as AnyTool;
}

/**
 * The tools a Mastra session has in-process (`extraTools`), for a Claude Code
 * session over MCP: the brokered source-control tools (push, change requests,
 * reviews, test checks), review sources, sandbox recreation, integrations'
 * tools. They run with the session's own context and its checkout's sandbox,
 * with credentials the server holds, so none enter the agent's environment.
 */
export async function createClaudeSessionTools(
  scope: FactoryMcpToolScope,
  deps: {
    sessionTools: (requestContext: RequestContext) => Promise<Record<string, unknown>>;
    /** The sandbox the session's checkout lives in. */
    sandboxFor: (sessionId: string) => Promise<unknown>;
  },
): Promise<Record<string, AnyTool>> {
  const requestContext = boundRunRequestContext(scope);
  const workspace = async () => {
    const sandbox = await deps.sandboxFor(scope.sessionId);
    return sandbox ? { sandbox } : undefined;
  };
  const tools: Record<string, AnyTool> = {};
  for (const [name, tool] of Object.entries(await deps.sessionTools(requestContext))) {
    tools[name] = asMcpTool(tool as AnyTool, requestContext, workspace);
  }
  return tools;
}

/** Git in a local checkout, for the reproduction-test recorder and guard; a failed command answers with its exit code. */
/**
 * The checkout of `repository` under a session's working directory. A session
 * spanning several repositories runs in the directory holding them, one
 * checkout per repository; a single-repository session runs in its checkout.
 */
export function repositoryCheckout(
  cwd: string,
  repository: string | undefined,
  requireRepository = false,
): string | undefined {
  const spansSeveral = !existsSync(path.join(cwd, '.git'));
  if (!repository) {
    if (spansSeveral && requireRepository) {
      throw new Error('This session spans several repositories; pass `repository` to name the one the test went into.');
    }
    return spansSeveral ? undefined : cwd;
  }
  if (!spansSeveral) return cwd;
  const dir = repoDirUnder(cwd, repository);
  return existsSync(dir) ? dir : undefined;
}

export function checkoutGit(cwd: string): SessionGit {
  return args =>
    new Promise(resolve => {
      execFile('git', ['-C', cwd, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ exitCode: error ? (typeof code === 'number' ? code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

/**
 * The tools only a bound run has, for a Claude Code session reaching the
 * Factory MCP endpoint with its session token:
 *
 * - the governed card move (`factory_transition_work_item`), review verdicts and
 *   reproduction-test recording, exactly the ones a bound Mastra run gets, for
 *   the card this session is bound to;
 * - `factory_bound_work_item`, the bound card's stage and revision as they are
 *   now; the `factory-phase` signal only opens each turn.
 */
export async function createClaudeBoundTools(
  scope: FactoryMcpToolScope,
  deps: {
    storage: WorkItemsStorage;
    transitionService: Pick<FactoryTransitionService, 'transition'>;
    boards: BoardRegistry;
    sessions?: FactorySessionSourceLookup;
    /** The session's checkout on this host, where the CLI runs; without it the tester cannot record its failing test. */
    checkoutFor?: (sessionId: string) => Promise<string | undefined>;
  },
): Promise<Record<string, AnyTool>> {
  const requestContext = boundRunRequestContext(scope);
  const transitionTools = (await createFactoryTransitionTools({
    requestContext,
    storage: deps.storage,
    transitionService: deps.transitionService,
    boards: deps.boards,
    ...(deps.sessions ? { sessions: deps.sessions } : {}),
    ...(deps.checkoutFor
      ? {
          sessionGit: async ({ repository, requireRepository }) => {
            const cwd = await deps.checkoutFor!(scope.sessionId);
            const checkout = cwd ? repositoryCheckout(cwd, repository, requireRepository) : undefined;
            return checkout ? checkoutGit(checkout) : undefined;
          },
        }
      : {}),
  })) as Record<string, AnyTool>;
  const tools: Record<string, AnyTool> = {};
  for (const [name, tool] of Object.entries(transitionTools)) tools[name] = asMcpTool(tool, requestContext);
  tools.factory_bound_work_item = createTool({
    id: 'factory_bound_work_item',
    description:
      'Read the Factory work item this session is bound to: its board, current stage, revision (pass it as `expectedRevision` to factory_transition_work_item), your role, title and source. The `factory-phase` signal at the start of the turn says the same; this reads it now, after a move.',
    inputSchema: z.object({}),
    execute: async () => {
      const binding = await deps.storage.findActiveRunBindingByThread({
        orgId: scope.orgId,
        threadId: scope.threadId,
        resourceId: scope.resourceId,
        sessionId: scope.sessionId,
      });
      if (!binding) throw new Error('This session is not bound to a work item right now.');
      const item = await deps.storage.get({ orgId: binding.orgId, id: binding.workItemId });
      if (!item) throw new Error('The bound work item no longer exists.');
      return {
        workItemId: item.id,
        board: item.board ?? 'work',
        stage: item.stages[0] ?? null,
        revision: item.revision,
        role: binding.role,
        title: item.title,
        triageType: item.triageType ?? null,
        source: item.externalSource ? { type: item.externalSource.type, url: item.externalSource.url ?? null } : null,
      };
    },
  }) as AnyTool;
  return tools;
}
