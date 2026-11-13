import { useState } from 'react';

import { useChatRuntime } from '../context/useChatRuntime';
import { useChatTranscript } from '../context/useChatTranscript';
import { omWork } from '../services/om';
import { lineState, runActivity, spokenByStretch } from '../services/run-activity';
import { SANDBOX_SETUP_SUMMARY_MIN_MS } from '../services/sandbox-setup';
import { RunLine } from './RunLine';
import { SandboxSetupLine } from './SandboxSetupLine';

/**
 * The agent's state for the whole run: what it is doing while it works, a held prompt while it
 * waits on the user, then done or error for a beat before the line fades out. A run already over
 * when the line mounts, or whose exit has faded, draws nothing until another run starts.
 *
 * While the session's sandbox is being set up the line says that instead (the run cannot do
 * anything else yet); a setup that took a while leaves its time above the run's line, and a failed
 * one stays until the next run.
 */
export function ActivityLine({ stretchLive }: { stretchLive: boolean }) {
  const { busy, transcript } = useChatTranscript();
  const runtime = useChatRuntime();
  const activity = runActivity(transcript.entries, transcript.lastEntryBeforeRun);
  const live = busy || activity === 'waiting';
  const run = runtime.runsStarted;
  const [settledRun, setSettledRun] = useState(live ? undefined : run);
  const setup = runtime.sandboxSetup;
  if (setup?.status === 'running') return <SandboxSetupLine setup={setup} />;

  const state = lineState(activity, busy, Object.values(omWork(runtime)).includes('blocking'));
  const runLine =
    state === 'writing' || (stretchLive && spokenByStretch(state)) || (!live && settledRun === run) ? null : (
      <RunLine state={state} live={live} onSettled={() => setSettledRun(run)} />
    );
  const setupLine =
    setup &&
    (setup.status === 'failed' ||
      setup.notices.length > 0 ||
      (runLine && live && setup.elapsedMs >= SANDBOX_SETUP_SUMMARY_MIN_MS)) ? (
      <SandboxSetupLine setup={setup} />
    ) : null;
  if (!setupLine) return runLine;
  return (
    <>
      {setupLine}
      {runLine}
    </>
  );
}
