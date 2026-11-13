/**
 * The agent harness contract: everything the Factory runtime needs from the
 * thing that actually runs agents (Mastra's AgentController, Claude Code, …).
 *
 * The runtime only drives sessions through this contract and never imports an
 * agent framework. A harness owns how a session keeps its context, memory and
 * transcript; the Factory owns cards, bindings, rules and human gates.
 *
 * The shape follows the session surface the dispatcher was built against
 * (signals that wake or are delivered into a live run, tool suspensions for
 * human gates). A harness without those primitives emulates them: a turn-based
 * harness answers a "suspension" by ending the turn and resuming the session.
 */
import type { HarnessModels } from './models/facet.ts';
import type { HarnessUsage } from './usage/facet.ts';

/**
 * Per-run context the harness builds for a delivery and reads back while the
 * run executes (caller identity, binding, workspace). Opaque to the runtime,
 * which only passes it along.
 */
export interface AgentRunContext {
  get(key: string): unknown;
}

export type AgentRunEndReason = 'complete' | 'aborted' | 'error' | 'suspended';

/** Token usage for one model step, as the harness reports it. */
export interface AgentTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;
}

/**
 * Session events the runtime acts on. Harnesses emit more (messages, tool
 * calls, …) for the UI; the runtime ignores anything not listed here.
 */
export type AgentEvent =
  | { type: 'agent_end'; reason?: AgentRunEndReason }
  | { type: 'usage_update'; usage: AgentTokenUsage }
  | { type: 'error'; error: unknown }
  /** The run parked on a tool that waits for a person (`submit_plan`, `ask_user`, …). */
  | { type: 'tool_suspended'; toolName: string; toolCallId: string }
  | { type: 'tool_suspension_cancelled'; toolCallId: string }
  /** Background memory failed and aborted the run; harnesses without such memory never emit these. */
  | { type: 'om_observation_failed' | 'om_buffering_failed'; error?: string };

export type AgentEventListener = (event: AgentEvent) => void;

/** A person's answer to a plan the run submitted for approval. */
export interface PlanDecision {
  action: 'approved' | 'rejected';
  feedback?: string;
  path?: string;
  title?: string;
  plan?: string;
}

/**
 * What a delivery into a session carries: a user turn, or a skill kickoff. A
 * skill kickoff is system-generated, not something a person typed; the harness
 * shows it to the model as the named skill (`<skill name="…">`) and records the
 * skill name in traces and memory. Its contents reach the model as written.
 */
export type AgentSignalInput =
  | { id: string; type: 'user'; tagName: 'user'; contents: string }
  | { id: string; type: 'reactive'; tagName: 'skill'; attributes: { name: string }; contents: string }
  /** Shows the thread's goal to the agent: the objective a phase's runs pursue. */
  | {
      id: string;
      type: 'system-reminder';
      contents: string;
      attributes: { type: 'goal' };
      metadata: { goalId?: string; goalMaxTurns?: number; judgeModelId?: string };
    };

/** A thread's goal: the objective its runs pursue, judged in-loop until met. */
export interface AgentGoalObjective {
  id?: string;
  objective: string;
  status: 'active' | 'paused' | 'done';
  maxRuns?: number;
  judgeModelId?: string;
}

/**
 * A harness that judges a goal in its run loop. A phase whose runner sets a goal holds it here;
 * a harness without one gets the objective in the kickoff instead and runs it once.
 */
export interface AgentGoals {
  getObjective(input: { threadId: string }): Promise<AgentGoalObjective | undefined>;
  setObjective(
    objective: string,
    options: { id: string; threadId: string; resourceId?: string; maxRuns?: number; judgeModelId?: string },
  ): Promise<AgentGoalObjective | undefined>;
  updateObjectiveOptions(input: {
    threadId: string;
    status: AgentGoalObjective['status'];
  }): Promise<AgentGoalObjective | undefined>;
}

export interface AgentSignalResult {
  accepted: Promise<{ accepted: true; runId?: string; action?: string }>;
}

export interface AgentNotificationResult {
  persisted?: Promise<unknown>;
  accepted?: Promise<{
    /** `wake`: an idle session started a run for it; `deliver`: it joined the run in flight. */
    action?: string;
    output?: { consumeStream(): Promise<unknown> };
  }>;
}

export interface AgentNotificationInput {
  source: string;
  kind: string;
  summary: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  payload?: unknown;
  dedupeKey?: string;
  sourceId?: string;
  /** Notifications with the same key that wait while the session is busy merge into one. */
  coalesceKey?: string;
}

export interface AgentNotificationOptions {
  ifActive?: { behavior?: 'deliver' | 'persist' };
  ifIdle?: { behavior?: 'persist' | 'wake' };
  requestContext?: AgentRunContext;
}

/** One agent session: a conversation with its own thread, workspace and run state. */
export interface AgentSession {
  readonly thread: {
    /** The current thread, or undefined before the session has one. */
    getId(): string | undefined;
    requireId(): string;
    switch(input: { threadId: string }): Promise<unknown>;
    /** Messages of the thread's current run window; a delivered signal appears here under its id. */
    listActiveMessages(): Promise<Array<{ id: string }>>;
    getSetting(input: { key: string }): Promise<unknown>;
    setSetting(input: { key: string; value: unknown }): Promise<void>;
  };
  readonly stream: { isActive(): boolean };
  readonly run: { isRunning(): boolean };
  readonly suspensions: { hasPending(): boolean };
  /** Stops the run in flight; `source` names who stopped it, for a harness that logs it. */
  abort(source?: string): void;
  sendMessage(input: { content: string; requestContext?: AgentRunContext }): Promise<unknown>;
  /** Starts a run on an idle session, or joins the run in flight. */
  sendSignal(
    input: AgentSignalInput,
    options: { requestContext: AgentRunContext; requireDelivery?: boolean },
  ): AgentSignalResult;
  sendNotificationSignal(
    input: AgentNotificationInput,
    options?: AgentNotificationOptions,
  ): Promise<AgentNotificationResult>;
  subscribe(listener: AgentEventListener): () => void;
  /** Answers the human gate the run is parked on; for `submit_plan` the resume data is a {@link PlanDecision}. */
  respondToToolSuspension(input: {
    resumeData: PlanDecision;
    toolCallId?: string;
    /** The run's own context, so resuming it resolves the session's workspace as the run does. */
    requestContext?: AgentRunContext;
  }): Promise<void>;
}

/** A skill as the harness can activate it in a session. */
export interface AgentSkill {
  name: string;
  /** False for skills only the harness itself may load. */
  userInvocable: boolean;
  /** The skill's instructions, formatted the way this harness activates a skill. */
  activation: string;
}

export interface AgentRunContextInput {
  /** Who the run acts for. */
  userId: string;
  orgId: string;
  threadId: string;
  resourceId: string;
}

/** The engine behind every session of one Factory. */
export interface AgentHarness {
  getSession(sessionId: string): Promise<AgentSession | undefined>;
  /** Runs in flight in this process, by thread. */
  listActiveThreadRuns(): Array<{ threadId: string; runId?: string; resourceId?: string }>;
  /** Builds the context a delivery into this session runs with. */
  runContext(session: AgentSession, input: AgentRunContextInput): AgentRunContext;
  /** Looks a skill up in the session's workspace, refreshing what the harness caches. */
  findSkill(session: AgentSession, name: string): Promise<AgentSkill | undefined>;
  /** The session's goal facet and the model that judges it; undefined when the harness has no goals. */
  goals?(session: AgentSession): { goals: AgentGoals; judgeModelId?: string } | undefined;
  /**
   * The harness's models and how a session's pick is checked and applied (`./models/facet.ts`);
   * undefined when the harness offers no model choice. The server registers it in its
   * `HarnessModelRegistry`, which serves `/web/config/models`, the chat's model switch and the
   * agent's `factory_switch_session_model`.
   */
  readonly models?: HarnessModels;
  /**
   * The harness's accounts' allowances (`./usage/facet.ts`); undefined when it has no subscription
   * accounts. The server registers it in its `HarnessUsageRegistry`, which serves the accounts' usage
   * windows. Token counts come from `usage_update` events, not from here.
   */
  readonly usage?: HarnessUsage;
}
