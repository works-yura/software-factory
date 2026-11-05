import type { MastraMessagePart } from '@mastra/core/agent-controller';
import { Sparkles } from 'lucide-react';
import { ActivityItem } from '@mastra/playground-ui/components/ai/activity';
import { isTaskTool } from '@mastra/playground-ui/components/ai/tool-call';
import { cn } from '@mastra/playground-ui/utils/cn';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatRuntime } from '../context/useChatRuntime';
import { useChatTranscript } from '../context/useChatTranscript';
import { omWork } from '../services/om';
import { lineState, runActivity, spokenByStretch } from '../services/run-activity';
import { RunLine } from './RunLine';

/**
 * The agent's state for the whole run: what it is doing while it works, a held prompt while it
 * waits on the user, then done or error for a beat before the line fades out. A run already over
 * when the line mounts, or whose exit has faded, draws nothing until another run starts.
 */
export function ActivityLine({ stretchLive }: { stretchLive: boolean }) {
  const { busy, transcript } = useChatTranscript();
  const runtime = useChatRuntime();
  const activity = runActivity(transcript.entries, transcript.lastEntryBeforeRun);
  const live = busy || activity === 'waiting';
  const run = runtime.runsStarted;
  const [settledRun, setSettledRun] = useState(live ? undefined : run);
  const state = lineState(activity, busy, Object.values(omWork(runtime)).includes('blocking'));
  if (state === 'writing' || (stretchLive && spokenByStretch(state))) return null;
  if (!live && settledRun === run) return null;
  return <RunLine state={state} live={live} onSettled={() => setSettledRun(run)} />;
}
