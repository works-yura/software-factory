import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef } from 'react';

import { useApiConfig } from '../../../../api/config';
import { ChatConnectionContext } from '../context/ChatConnectionContext';
import { ChatSessionContext } from '../context/ChatSessionContext';
import { AGENT_CONTROLLER_ID } from '../services/constants';

/**
 * A chat session parked because every account it may use is out of usage (Claude Code, Codex): it
 * resumes on its own at `parkedUntil`. The session state route's `usageLimit`.
 */
export interface SessionUsageLimit {
  reason: 'usage_limit';
  parkedUntil: string;
  resetKnown: boolean;
  since: string;
  attempts: number;
  message: string;
}

/** What `POST …/sessions/:id/resume` answers. */
export interface SessionResumeResult {
  ok: boolean;
  action?: 'resumed' | 'parked' | 'ended';
  reason?: string;
  usageLimit: SessionUsageLimit | null;
}

/** How often a parked chat checks whether the server resumed it meanwhile. */
const PARKED_POLL_MS = 60_000;

export function sessionUsageLimitKey(sessionId: string | undefined) {
  return ['agent-controller', AGENT_CONTROLLER_ID, 'usage-limit', sessionId ?? null] as const;
}

function sessionPath(sessionId: string) {
  return `/api/agent-controller/${encodeURIComponent(AGENT_CONTROLLER_ID)}/sessions/${encodeURIComponent(sessionId)}`;
}

/**
 * The usage-limit park of the chat's session, for a harness whose accounts are the Factory's
 * (Claude Code, Codex); `null` when it is not parked. Read again whenever a run ends or starts,
 * and once a minute while parked, so a resume the server made shows without a reload.
 */
export function useSessionUsageLimit() {
  const session = useContext(ChatSessionContext);
  const connection = useContext(ChatConnectionContext);
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  const sessionId = session?.sessionId;
  const enabled = Boolean(sessionId && session?.resourceReady && session?.harness?.modelScope === 'factory');
  const query = useQuery({
    queryKey: sessionUsageLimitKey(sessionId),
    queryFn: async () => {
      const state = await client.get<{ usageLimit?: SessionUsageLimit | null }>(sessionPath(sessionId!));
      return state.usageLimit ?? null;
    },
    enabled,
    refetchInterval: query => (query.state.data ? PARKED_POLL_MS : false),
  });
  const running = connection?.state?.running;
  const lastRunning = useRef(running);
  useEffect(() => {
    if (lastRunning.current === running) return;
    lastRunning.current = running;
    if (enabled) void queryClient.invalidateQueries({ queryKey: sessionUsageLimitKey(sessionId), exact: true });
  }, [enabled, queryClient, running, sessionId]);
  return { usageLimit: enabled && !running ? (query.data ?? null) : null, refetch: query.refetch };
}

/** "Resume now": tries the parked session at once; still limited, the park's new time comes back. */
export function useResumeSessionMutation() {
  const session = useContext(ChatSessionContext);
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  const sessionId = session?.sessionId;
  return useMutation({
    mutationFn: () => client.post<SessionResumeResult>(`${sessionPath(sessionId!)}/resume`),
    onSuccess: result => {
      queryClient.setQueryData(sessionUsageLimitKey(sessionId), result.usageLimit ?? null);
    },
  });
}
