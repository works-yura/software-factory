import { Txt } from '@mastra/playground-ui/components/Txt';
import type { ReactNode, Ref } from 'react';
import { useLocation } from 'react-router';

import { lazyLabels } from '../../../i18n/lazy';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

const PAGE_IDS = ['activity', 'knowledge', 'new', 'new-factory', 'review', 'rules', 'supervisor', 'work'] as const;
const PAGE_TITLES: Readonly<Record<string, string>> = lazyLabels(PAGE_IDS, page => `chat:pageTitles.${page}`);

function routeTitle(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const page = segments.at(-1);

  if (page && PAGE_TITLES[page]) return PAGE_TITLES[page];
  if (segments.includes('threads')) return tk('pageTitles.session');
  if (segments.includes('workspaces') || segments.includes('user')) return tk('pageTitles.new');
  return 'Factory';
}

export function MobilePageTitle({
  children,
  ref,
  tabIndex,
}: {
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
  tabIndex?: number;
}) {
  const { pathname } = useLocation();

  return (
    <Txt tone="ink" as="h1" variant="heading" ref={ref} tabIndex={tabIndex} className="min-w-0 truncate md:hidden">
      {children ?? routeTitle(pathname)}
    </Txt>
  );
}
