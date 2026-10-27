import { cn } from '@mastra/playground-ui/utils/cn';
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

  // A dropped stream makes every other status stale, the composer's working ring included.
  if (status === 'reconnecting')
    return (
      <span className={statusItem} role="status" aria-live="polite">
        <Circle size={10} /> {t('status.reconnecting')}
      </span>
    );
  if (status === 'error')
    return (
      <span
        className={cn(statusItem, 'text-destructive-foreground [&_svg]:text-destructive-foreground')}
        role="status"
        aria-live="polite"
        title={t('status.reconnectHint')}
      >
        <Circle size={10} /> {t('status.disconnected')}
      </span>
    );
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
