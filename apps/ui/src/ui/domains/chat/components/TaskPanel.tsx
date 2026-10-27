import { TaskList } from '@mastra/playground-ui/components/ai/task-list';

import { useTranslation } from 'react-i18next';

import { useChatTranscript } from '../context/useChatTranscript';

export function TaskPanel() {
  const { t } = useTranslation('chat');
  const { transcript } = useChatTranscript();
  const hasVisibleTasks = transcript.tasks.some(task => task.status !== 'completed');

  if (!hasVisibleTasks) return null;

  return (
    <div role="region" aria-label={t('session.currentTasks')} data-testid="task-panel">
      <TaskList tasks={transcript.tasks} />
    </div>
  );
}
