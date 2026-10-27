import { Breadcrumb } from '@mastra/playground-ui/components/Breadcrumb';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useSidebarHeaderSlots } from './useSidebarHeaderSlots';

interface ChatPageLayoutProps {
  /** `Crumb` elements; the last one is the current page. */
  crumbs?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
}

/** `PageLayout` for chat pages (new session, thread, supervisor) with a crumb trail. */
export function ChatPageLayout({ crumbs, headerActions, children }: ChatPageLayoutProps) {
  const { t } = useTranslation('chat');
  const slots = useSidebarHeaderSlots({
    breadcrumbs: crumbs && (
      <Breadcrumb label={t('layout.breadcrumb')} className="min-w-0 flex-1 overflow-hidden" listClassName="min-w-0">
        {crumbs}
      </Breadcrumb>
    ),
    headerActions,
  });

  return (
    <PageLayout variant="fit" {...slots}>
      {children}
    </PageLayout>
  );
}
