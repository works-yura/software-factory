import { Spinner } from '@mastra/playground-ui/components/Spinner';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface WorkspaceOverviewStatusProps {
  loading: boolean;
  error?: Error;
  children: ReactNode;
}

export function WorkspaceOverviewStatus({ loading, error, children }: WorkspaceOverviewStatusProps) {
  const { t } = useTranslation('workspaces');
  if (loading) return <Spinner size="sm" />;
  if (error) return <span className="text-muted-foreground">{t('overview.unavailable')}</span>;

  return children;
}
