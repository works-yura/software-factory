import { Button } from '@mastra/playground-ui/components/Button';
import { FileDiff, NotepadText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SkeletonRows } from '../../../ui/SkeletonRows';

/** Mirrors the compact overview while the session's authorized details resolve. */
export function WorkspaceOverviewSkeleton() {
  const { t } = useTranslation('workspaces');
  return (
    <aside aria-label={t('overview.label')} aria-busy="true" className="flex min-w-0 flex-col gap-0.5 p-1.5">
      <Button disabled className="w-full justify-start" size="sm" variant="ghost">
        <FileDiff />
        <span>{t('overview.changes')}</span>
        <span className="ml-auto">
          <SkeletonRows label={t('overview.loadingDetails')} rows={1} rowClassName="h-3 w-16" />
        </span>
      </Button>
      <Button disabled className="w-full justify-start" size="sm" variant="ghost">
        <NotepadText />
        <span>{t('overview.files')}</span>
      </Button>
    </aside>
  );
}
