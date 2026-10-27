import { Spinner } from '@mastra/playground-ui/components/Spinner';

import { useTranslation } from 'react-i18next';

import { useChatTranscript } from '../context/useChatTranscript';

export function TranscriptHistoryLoader() {
  const { t } = useTranslation('chat');
  const { loadMore } = useChatTranscript();
  if (!loadMore.isLoading) return null;

  return (
    <div className="flex w-full justify-center py-2">
      <Spinner size="sm" className="text-muted-foreground" aria-label={t('session.loadingOlder')} />
    </div>
  );
}
