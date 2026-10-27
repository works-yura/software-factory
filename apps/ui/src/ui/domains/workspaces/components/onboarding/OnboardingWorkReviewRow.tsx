import { ListTodo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkSourceConnections, WORK_SOURCE_NAME, WORK_SOURCES } from '../../hooks/useWorkSourceConnections';
import { OnboardingReviewRow } from './OnboardingReviewRow';

export function OnboardingWorkReviewRow({ disabled, onEdit }: { disabled: boolean; onEdit: () => void }) {
  const { t } = useTranslation('workspaces');
  const status = useWorkSourceConnections();
  const connected = WORK_SOURCES.filter(source => status[source]).map(source => WORK_SOURCE_NAME[source]);
  return (
    <OnboardingReviewRow
      icon={<ListTodo />}
      label={t('review.work')}
      value={connected.join(', ') || t('review.setUpLater')}
      detail={connected.length ? t('review.workConnected') : undefined}
      disabled={disabled}
      onEdit={onEdit}
    />
  );
}
