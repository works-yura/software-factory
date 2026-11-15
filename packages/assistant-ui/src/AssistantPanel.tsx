import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Header, HeaderAction } from '@mastra/playground-ui/components/Header';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { SkeletonText } from '@mastra/playground-ui/components/Skeleton';
import { StatusDot } from '@mastra/playground-ui/components/StatusIndicators';
import type { StatusPresentation } from '@mastra/playground-ui/components/StatusIndicators';
import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import { ThreadList, ThreadListItem, ThreadListItems } from '@mastra/playground-ui/components/ThreadList';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowLeft, Inbox, MessageSquareDashed, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { REQUEST_STATUSES, useAssistantRequests } from './api';
import type { AssistantRequest, RequestStatus } from './api';
import { NewRequestForm } from './NewRequestForm';
import { NotesView } from './NotesView';
import { RequestThread } from './RequestThread';

type Filter = 'open' | 'all' | RequestStatus;
type Tab = 'requests' | 'notes';

export function filterRequests(requests: AssistantRequest[], filter: Filter): AssistantRequest[] {
  if (filter === 'all') return requests;
  if (filter === 'open') return requests.filter(request => request.status !== 'closed');
  return requests.filter(request => request.status === filter);
}

/** A request's status as the kit's status dot: amber while someone has to act, green once answered. */
const STATUS_DOT: Record<RequestStatus, Omit<StatusPresentation, 'label' | 'description'>> = {
  new: { tone: 'neutral' },
  waiting_factory: { tone: 'progress', glyph: 'ring' },
  waiting_me: { tone: 'progress' },
  answered: { tone: 'success' },
  closed: { tone: 'neutral', glyph: 'ring' },
};

/**
 * One request in the list, on the one line a thread list row has: the status dot, the topic (bold
 * while unread), and the status in words at the end.
 */
function RequestRow({ request }: { request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const label = t(`status.${request.status}`);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusDot status={request.status} presentation={() => ({ ...STATUS_DOT[request.status], label, description: label })} decorative />
      <Txt as="span" variant={request.unread ? 'label' : 'body-sm'} className="min-w-0 flex-1 truncate">
        {request.topic}
      </Txt>
      <Txt as="span" variant="caption" tone="muted" className="shrink-0">
        {label}
      </Txt>
    </span>
  );
}

/**
 * The assistant's panel: requests on the left (filter by status, the new ones counted), the open
 * thread on the right, a notes tab. On a phone (`compact`) one view at a time: the list first, a
 * thread or the new-request form over it.
 */
export function AssistantPanel({
  compact = false,
  hint,
  onClose,
}: {
  compact?: boolean;
  /** The Factory the page belongs to, offered first when asking or handing over. */
  hint?: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation('assistant');
  const requests = useAssistantRequests();
  const [tab, setTab] = useState<Tab>('requests');
  const [filter, setFilter] = useState<Filter>('open');
  const [selected, setSelected] = useState<string | 'new' | undefined>(undefined);
  const all = requests.data ?? [];
  const shown = filterRequests(all, filter);
  const newCount = all.filter(request => request.status === 'new').length;
  const detailOpen = selected !== undefined;

  const list = (
    <div className={compact ? 'flex min-h-0 flex-1 flex-col' : 'border-border flex min-h-0 w-72 shrink-0 flex-col border-r'}>
      <Header border={false}>
        <Select value={filter} onValueChange={value => setFilter(value as Filter)}>
          <SelectTrigger size="sm" aria-label={t('filter.label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{t('filter.open')}</SelectItem>
            <SelectItem value="all">{t('filter.all')}</SelectItem>
            {REQUEST_STATUSES.map(status => (
              <SelectItem key={status} value={status}>
                {t(`status.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setSelected('new')}>
          {t('panel.newRequest')}
        </Button>
      </Header>
      {newCount > 0 ? (
        <Txt as="p" variant="caption" tone="muted" className="px-3" data-testid="assistant-new-count">
          {t('panel.newCount', { count: newCount })}
        </Txt>
      ) : null}
      {requests.isError ? <Notice variant="destructive">{t('panel.loadFailed', { message: requests.error.message })}</Notice> : null}
      <div className="min-h-0 flex-1">
        {requests.isPending ? (
          <div className="flex flex-col gap-3 p-3" role="status" aria-label={t('panel.loading')}>
            {[0, 1, 2].map(row => (
              <SkeletonText key={row} className="w-full" />
            ))}
          </div>
        ) : requests.data && shown.length === 0 ? (
          <EmptyState iconSlot={<Inbox />} titleSlot={t('panel.empty')} />
        ) : (
          <ThreadList aria-label={t('panel.requests')} embedded>
            <ThreadListItems>
              {shown.map(request => (
                <ThreadListItem key={request.id} isActive={selected === request.id} onClick={() => setSelected(request.id)}>
                  <RequestRow request={request} />
                </ThreadListItem>
              ))}
            </ThreadListItems>
          </ThreadList>
        )}
      </div>
    </div>
  );

  const detail =
    selected === 'new' ? (
      <NewRequestForm onCreated={request => setSelected(request.id)} onCancel={() => setSelected(undefined)} />
    ) : selected ? (
      <RequestThread key={selected} requestId={selected} hint={hint} />
    ) : (
      <EmptyState variant="fill" iconSlot={<MessageSquareDashed />} titleSlot={t('panel.selectRequest')} />
    );

  return (
    <Tabs<Tab>
      defaultTab="requests"
      value={tab}
      onValueChange={setTab}
      aria-label={t('panel.title')}
      className={
        compact
          ? 'flex h-full min-h-0 flex-col [--assistant-surface:var(--color-dialog)]'
          : 'flex h-full min-h-0 flex-col [--assistant-surface:var(--color-card)]'
      }
    >
      <Header>
        {compact && detailOpen && tab === 'requests' ? (
          <Button size="icon-sm" variant="ghost" aria-label={t('panel.back')} onClick={() => setSelected(undefined)}>
            <ArrowLeft />
          </Button>
        ) : null}
        <Txt as="h2" variant="heading">
          {t('panel.title')}
        </Txt>
        <HeaderAction>
          <TabList size="sm">
            <Tab value="requests">{t('panel.requests')}</Tab>
            <Tab value="notes">{t('panel.notes')}</Tab>
          </TabList>
          <Button size="icon-sm" variant="ghost" aria-label={t('launcher.close')} onClick={onClose}>
            <X />
          </Button>
        </HeaderAction>
      </Header>
      <TabContent value="requests" flush className="flex-1">
        {compact ? (
          detailOpen ? (
            detail
          ) : (
            list
          )
        ) : (
          <div className="flex min-h-0">
            {list}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
          </div>
        )}
      </TabContent>
      <TabContent value="notes" flush className="flex-1">
        <NotesView />
      </TabContent>
    </Tabs>
  );
}
