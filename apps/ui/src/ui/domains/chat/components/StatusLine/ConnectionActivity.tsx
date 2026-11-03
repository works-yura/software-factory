import { Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useChatConnection } from '../../context/useChatConnection';
import { useChatSessionContext } from '../../context/useChatSessionContext';
import { useChatTranscript } from '../../context/useChatTranscript';
import { usePreparingThreadId } from '../../hooks/usePreparingThreadId';

const statusItem = 'inline-flex items-center gap-1 text-muted-foreground [&_svg]:text-placeholder';

export function ConnectionActivity() {
  const { t } = useTranslation('chat');
  const { status } = useChatConnection();
  const { workspacePending } = useChatSessionContext();
  const { phase } = useChatTranscript();
  const preparingThreadId = usePreparingThreadId();

  // The notice above the composer owns connection failures; other activity is stale until recovery.
  if (status === 'reconnecting' || status === 'error') return null;
  // preparing message sets busy; preparation status takes precedence
  if (preparingThreadId)
    return (
      <span className={statusItem} role="status" aria-live="polite">
        <Circle size={10} /> {workspacePending ? t('status.preparingWorkspace') : t('status.connecting')}
      </span>
    );
  // Spinning composer ring is the visible cue; this keeps the state announced.
  if (phase === 'working')
    return (
      <span className="sr-only" role="status" aria-live="polite">
        {t('status.working')}
      </span>
    );
  return null;
}
