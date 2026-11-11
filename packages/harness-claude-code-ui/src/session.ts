// The session the chat channel and routes drive: any turn-based harness session that records the
// shared transcript (`@factory/harness/transcript`) and parks on plans, permissions and questions.
// Claude Code and Codex sessions both are one; the type is structural, so neither imports the other.
import type { AgentRunContext, AgentSession, PlanDecision } from '@factory/harness';
import type { PermissionRequest, PlanGate, TranscriptEntry } from '@factory/harness/transcript';

export type ChatDelivery = 'message' | 'follow-up' | 'steer';

export interface ChatTranscriptSession
  extends Pick<AgentSession, 'thread' | 'run' | 'subscribe' | 'abort' | 'respondToToolSuspension'> {
  readonly id: string;
  readonly resourceId: string | undefined;
  readonly runId: string | undefined;
  /** The thread's mode (`planning`, or the harness's own); the state route shows it. */
  readonly mode: string | undefined;
  readonly pendingPlan: PlanGate | undefined;
  readonly pendingPermission: PermissionRequest | undefined;
  readonly queuedFollowUps: number;
  /** The provider of the session's models, stamped beside a reply's model id; Anthropic when absent. */
  readonly modelProvider?: string;
  onTranscript(listener: (entry: TranscriptEntry, meta: { runId: string; threadId: string }) => void): () => void;
  sendChatMessage(input: { content: string; requestContext?: AgentRunContext; delivery?: ChatDelivery }): Promise<{ action: 'wake' | 'deliver' | 'queued' }>;
  respondToToolApproval(input: { approved: boolean; toolCallId?: string }): Promise<void>;
  answerQuestion(input: { answer: string | string[]; toolCallId?: string }): Promise<void>;
  /** Answers the plan gate without starting a run (a host's plan hook: the next stage starts the session). */
  queuePlanAnswer(input: { resumeData: PlanDecision; toolCallId?: string }): Promise<void>;
}
