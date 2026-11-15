import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { ThreadList, ThreadListEmpty, ThreadListItem, ThreadListItems } from '@mastra/playground-ui/components/ThreadList';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cn } from '@mastra/playground-ui/utils/cn';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { REQUEST_STATUSES, useAssistantRequests } from './api';
import type { AssistantRequest, RequestStatus } from './api';
import { NewRequestForm } from './NewRequestForm';
import { NotesView } from './NotesView';
import { RequestThread, StatusBadge } from './RequestThread';

type Filter = 'open' | 'all' | RequestStatus;
type Tab = 'requests' | 'notes';

export function filterRequests(requests: AssistantRequest[], filter: Filter): AssistantRequest[] {
  if (filter === 'all') return requests;
  if (filter === 'open') return requests.filter(request => request.status !== 'closed');
  return requests.filter(request => request.status === filter);
}

function RequestRow({ request }: { request: AssistantRequest }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 py-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {request.unread ? <span className="bg-accent1 size-2 shrink-0 rounded-full" aria-hidden="true" /> : null}
        <Txt as="span" variant="body-sm" className={cn('min-w-0 flex-1 truncate', request.unread && 'font-medium')}>
          {request.topic}
        </Txt>
      </span>
      <span className="flex items-center gap-1.5">
        <StatusBadge status={request.status} />
        {request.fromName ? (
          <Txt as="span" variant="caption" tone="muted" className="truncate">
            {request.fromName}
          </Txt>
        ) : null}
      </span>
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
    <div className={cn('flex min-h-0 flex-col', compact ? 'flex-1' : 'border-border w-72 shrink-0 border-r')}>
      <div className="flex items-center gap-2 p-2">
        <label className="sr-only" htmlFor="assistant-filter">
          {t('filter.label')}
        </label>
        <select
          id="assistant-filter"
          aria-label={t('filter.label')}
          className="border-border bg-surface2 text-body-sm h-8 min-w-0 flex-1 rounded-md border px-2"
          value={filter}
          onChange={event => setFilter(event.target.value as Filter)}
        >
          <option value="open">{t('filter.open')}</option>
          <option value="all">{t('filter.all')}</option>
          {REQUEST_STATUSES.map(status => (
            <option key={status} value={status}>
              {t(`status.${status}`)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="primary" onClick={() => setSelected('new')}>
          <Plus aria-hidden="true" />
          {t('panel.newRequest')}
        </Button>
      </div>
      {newCount > 0 ? (
        <Txt as="p" variant="caption" tone="muted" className="px-3" data-testid="assistant-new-count">
          {t('panel.newCount', { count: newCount })}
        </Txt>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {requests.isError ? <Notice variant="destructive">{t('panel.loadFailed', { message: requests.error.message })}</Notice> : null}
        <ThreadList aria-label={t('panel.requests')} embedded>
          <ThreadListItems>
            {shown.map(request => (
              <ThreadListItem key={request.id} isActive={selected === request.id} onClick={() => setSelected(request.id)}>
                <RequestRow request={request} />
              </ThreadListItem>
            ))}
          </ThreadListItems>
          {requests.data && shown.length === 0 ? <ThreadListEmpty>{t('panel.empty')}</ThreadListEmpty> : null}
        </ThreadList>
      </div>
    </div>
  );

  const detail =
    selected === 'new' ? (
      <NewRequestForm onCreated={request => setSelected(request.id)} onCancel={() => setSelected(undefined)} />
    ) : selected ? (
      <RequestThread key={selected} requestId={selected} hint={hint} />
    ) : (
      <div className="flex flex-1 items-center justify-center p-6">
        <Txt as="p" variant="caption" tone="muted">
          {t('panel.selectRequest')}
        </Txt>
      </div>
    );

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('panel.title')}>
      <header className="border-border flex items-center gap-2 border-b px-3 py-2">
        {compact && detailOpen && tab === 'requests' ? (
          <Button size="icon-sm" variant="ghost" aria-label={t('panel.back')} onClick={() => setSelected(undefined)}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        ) : null}
        <Txt as="h2" variant="heading" className="flex-1">
          {t('panel.title')}
        </Txt>
        <div role="tablist" aria-label={t('panel.title')} className="flex gap-1">
          {(['requests', 'notes'] as const).map(name => (
            <Button
              key={name}
              role="tab"
              aria-selected={tab === name}
              size="sm"
              variant={tab === name ? 'default' : 'ghost'}
              onClick={() => setTab(name)}
            >
              {t(`panel.${name}`)}
            </Button>
          ))}
        </div>
        <Button size="icon-sm" variant="ghost" aria-label={t('launcher.close')} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      {tab === 'notes' ? (
        <NotesView />
      ) : compact ? (
        detailOpen ? (
          detail
        ) : (
          list
        )
      ) : (
        <div className="flex min-h-0 flex-1">
          {list}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
        </div>
      )}
    </section>
  );
}
