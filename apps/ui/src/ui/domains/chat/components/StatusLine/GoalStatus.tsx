import { Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useChatRuntime } from '../../context/useChatRuntime';

/** Goal lifecycle indicator; hidden when there is no goal or it is done. */
export function GoalStatus() {
  const { t } = useTranslation('chat');
  const { goal } = useChatRuntime();

  if (!goal || goal.status === 'done') return null;

  return (
    <span className="text-badge-pink-indicator [&_svg]:text-badge-pink-indicator inline-flex items-center gap-1">
      <Target size={13} /> {goal.status === 'paused' ? t('status.goalPaused') : t('status.pursuingGoal')}
    </span>
  );
}
