import type { AgentControllerEvent } from '@mastra/core/agent-controller';

import type { LiveSession } from '@factory/session';

/** What the chat shows of a Claude Code session: its UI channel. */
export interface ClaudeLiveChannel {
  readonly session: { readonly id: string };
  readonly running: boolean;
  displayState(): {
    pendingSuspensions: ReadonlyMap<string, { toolName: string }>;
    pendingApprovals: ReadonlyMap<string, { toolName: string }>;
  };
  subscribe(listener: (event: AgentControllerEvent) => void): () => void;
}

/**
 * A Claude Code session as the live-session registry reads a Mastra one, so
 * the board marks its card waiting and the inbox lists it. A permission
 * request counts as parked like a plan does: a Mastra card run never asks
 * (it runs on auto-approve), but a Claude Code one stops until a person answers.
 */
export function claudeLiveSession(
  channel: ClaudeLiveChannel,
  tenant: { orgId: string; factoryProjectId: string | null },
): LiveSession {
  const state = {
    factoryOrgId: tenant.orgId,
    ...(tenant.factoryProjectId ? { factoryProjectId: tenant.factoryProjectId } : {}),
  };
  return {
    identity: { getId: () => channel.session.id },
    run: { isRunning: () => channel.running },
    state: { get: () => state },
    displayState: {
      get: () => {
        const display = channel.displayState();
        return { pendingSuspensions: new Map([...display.pendingSuspensions, ...display.pendingApprovals]) };
      },
    },
    subscribe: listener =>
      channel.subscribe(event => {
        // The registry dates a park from its suspension event; an approval request is the same kind of wait.
        if (event.type === 'tool_approval_required') {
          listener({ type: 'tool_suspended', toolCallId: event.toolCallId, toolName: event.toolName } as AgentControllerEvent);
          return;
        }
        listener(event);
      }),
  };
}
