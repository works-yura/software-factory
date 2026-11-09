import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SkeletonRows } from '../../../ui/SkeletonRows';

interface WorkspaceOverviewStatusProps {
  loading: boolean;
  error?: Error;
  children: ReactNode;
}

export function WorkspaceOverviewStatus({ loading, error, children }: WorkspaceOverviewStatusProps) {
  const { t } = useTranslation('workspaces');
  if (loading) return <SkeletonRows label={t('overview.loadingChanges')} rows={1} rowClassName="h-3 w-16" />;
  if (error) return <span className="text-muted-foreground">{t('overview.unavailable')}</span>;

  return children;
}
