import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Header, HeaderAction } from '@mastra/playground-ui/components/Header';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { SkeletonText } from '@mastra/playground-ui/components/Skeleton';
import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import { ThreadList, ThreadListItem, ThreadListItems } from '@mastra/playground-ui/components/ThreadList';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useKeydown } from '@mastra/playground-ui/keyboard/use-keydown';
import { ArrowLeft, Inbox, MessageSquareDashed, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { REQUEST_STATUSES, useAssistantRequests, useUpdateRequest } from './api';
import type { AssistantRequest, RequestStatus } from './api';
import { NewRequestForm } from './NewRequestForm';
import { NotesView } from './NotesView';
import type { NoteSelection } from './NotesView';
import { RequestStatusDot, RequestThread, ShortcutHint } from './RequestThread';
import { requestAge } from './time';

type Filter = 'open' | 'all' | RequestStatus;
type Tab = 'requests' | 'notes';

export function filterRequests(requests: AssistantRequest[], filter: Filter): AssistantRequest[] {
  if (filter === 'all') return requests;
  if (filter === 'open') return requests.filter(request => request.status !== 'closed');
  return requests.filter(request => request.status === filter);
}

export { requestAge } from './time';

/**
 * One request in the list, on the one line a thread list row has: the status dot, the topic (bold
 * while unread), and how long ago it changed at the end.
 */
function RequestRow({ request }: { request: AssistantRequest }) {
  const { t, i18n } = useTranslation('assistant');
  return (
    <span className="flex min-w-0 items-center gap-2" title={`${request.topic} · ${t(`status.${request.status}`)}`}>
      <RequestStatusDot status={request.status} />
      <Txt as="span" variant={request.unread ? 'label' : 'body-sm'} tone={request.unread ? 'ink' : undefined} className="min-w-0 flex-1 truncate">
        {request.topic}
      </Txt>
      {request.unread ? <span className="sr-only">{t('panel.unread')}</span> : null}
      <Txt as="span" variant="caption" tone="muted" className="shrink-0 tabular-nums">
        {requestAge(request.updatedAt, t, i18n.language)}
      </Txt>
    </span>
  );
}

/** What the list's keys do, under it on a desktop: j/k move, Enter goes to the reply, E closes, C brings a new one. */
function KeyboardHints() {
  const { t } = useTranslation('assistant');
  const hints: Array<[string[], string]> = [
    [['J', 'K'], t('keys.move')],
    [['↵'], t('keys.reply')],
    [['E'], t('keys.close')],
    [['C'], t('keys.new')],
  ];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2" aria-hidden="true">
      {hints.map(([keys, label]) => (
        <Txt key={label} as="span" variant="caption" tone="muted" className="flex items-center gap-1">
          {keys.map(key => (
            <Kbd key={key} size="xs">
              {key}
            </Kbd>
          ))}
          {label}
        </Txt>
      ))}
    </div>
  );
}

/** Fields, menus and pickers keep their own keys; the list's single-letter keys work everywhere else in the panel. */
const OWN_KEYS = 'input, textarea, select, [contenteditable], [role="combobox"], [role="listbox"], [role="menu"], [role="menuitem"], [role="option"], [role="radio"], [role="tab"]';

/** j/k/E/C on a Ukrainian layout come as о/л/у/с; both work. */
const KEYS = { next: ['j', 'о'], previous: ['k', 'л'], close: ['e', 'у'], create: ['c', 'с'] } as const;

/**
 * The assistant's panel, an inbox: requests on the left (filter by status, the new ones counted,
 * j/k to move, E to close and go on to the next), the open thread on the right, a notes tab. On a
 * phone (`compact`) one view at a time: the list first, a thread or the new-request form over it.
 */
export function AssistantPanel({
  compact = false,
  hint,
  onClose,
}: {
  compact?: boolean;
  /** The Factory the page belongs to, the default target when asking or handing over. */
  hint?: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation('assistant');
  const requests = useAssistantRequests();
  const update = useUpdateRequest();
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('requests');
  const [filter, setFilter] = useState<Filter>('open');
  const [selected, setSelected] = useState<string | 'new' | undefined>(undefined);
  const [note, setNote] = useState<NoteSelection | undefined>(undefined);
  /** Opens a request from anywhere in the panel (a note about it, the earlier one a source request continues). */
  const openRequest = (id: string) => {
    const known = all.find(request => request.id === id);
    if (known?.status === 'closed' && filter === 'open') setFilter('all');
    setTab('requests');
    setSelected(id);
  };
  const all = requests.data ?? [];
  const shown = filterRequests(all, filter);
  const newCount = all.filter(request => request.status === 'new').length;
  const detailOpen = selected !== undefined;
  const current = selected && selected !== 'new' ? selected : undefined;

  /** Inbox zero: after closing, the next request opens (the one above at the end); on a phone, back to the list. */
  const moveOn = (closedId: string) => {
    if (compact) return setSelected(undefined);
    const at = shown.findIndex(request => request.id === closedId);
    const rest = shown.filter(request => request.id !== closedId);
    setSelected(rest[Math.min(Math.max(at, 0), rest.length - 1)]?.id);
  };

  const focusRow = (index: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('li > button');
    rows?.[index]?.focus();
  };

  const step = (by: 1 | -1) => {
    if (shown.length === 0) return;
    const at = shown.findIndex(request => request.id === current);
    const next = at < 0 ? (by === 1 ? 0 : shown.length - 1) : Math.min(Math.max(at + by, 0), shown.length - 1);
    // On a phone the list is its own view: moving focuses a row, Enter opens it.
    if (compact) return focusRow(next);
    setSelected(shown[next]!.id);
    focusRow(next);
  };

  const closeCurrent = () => {
    if (!current) return;
    const request = all.find(item => item.id === current);
    if (!request || request.status === 'closed') return;
    update.mutate({ id: current, patch: { status: 'closed' } });
    moveOn(current);
  };

  const keys: Record<string, () => void> = {};
  for (const key of KEYS.next) keys[key] = () => step(1);
  for (const key of KEYS.previous) keys[key] = () => step(-1);
  for (const key of KEYS.close) keys[key] = closeCurrent;
  for (const key of KEYS.create) keys[key] = () => setSelected('new');
  // Enter on a desktop row (already open beside the list) goes on to the reply; on a phone the row's own click opens it.
  keys.Enter = () => root.current?.querySelector<HTMLTextAreaElement>('[data-slot="composer-input"]')?.focus();
  useKeydown(keys, {
    target: root,
    enabled: tab === 'requests',
    insideFields: true,
    shouldHandle: event => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OWN_KEYS)) return false;
      if (event.key === 'Enter') return !compact && Boolean(target?.closest('li > button'));
      return true;
    },
  });

  const list = (
    <div className={compact ? 'flex min-h-0 flex-1 flex-col' : 'border-border flex min-h-0 w-72 shrink-0 flex-col border-r'}>
      {/* One row in the 288px column: the filter with the new ones counted beside it, the new-request button icon-only. */}
      <Header border={false} className="min-w-0">
        <Select value={filter} onValueChange={value => setFilter(value as Filter)}>
          <SelectTrigger size="sm" variant="ghost" aria-label={t('filter.label')} className="min-w-0">
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
        {newCount > 0 ? (
          <Badge size="sm" variant="info" className="shrink-0 whitespace-nowrap" data-testid="assistant-new-count">
            {t('panel.newCount', { count: newCount })}
          </Badge>
        ) : null}
        <HeaderAction>
          <Button
            size="icon-sm"
            variant="primary"
            aria-label={t('panel.newRequest')}
            aria-keyshortcuts="C"
            tooltip={<ShortcutHint label={t('panel.newRequest')} keys={['C']} />}
            onClick={() => setSelected('new')}
          >
            <Plus />
          </Button>
        </HeaderAction>
      </Header>
      {requests.isError ? <Notice variant="destructive">{t('panel.loadFailed', { message: requests.error.message })}</Notice> : null}
      <div className="min-h-0 flex-1" ref={listRef}>
        {requests.isPending ? (
          <div className="flex flex-col gap-3 p-3" role="status" aria-label={t('panel.loading')}>
            {[0, 1, 2].map(row => (
              <SkeletonText key={row} className="w-full" />
            ))}
          </div>
        ) : requests.data && shown.length === 0 ? (
          <EmptyState iconSlot={<Inbox />} titleSlot={filter === 'open' ? t('panel.inboxZero') : t('panel.emptyFilter')} descriptionSlot={t('panel.empty')} />
        ) : (
          <ThreadList aria-label={t('panel.requests')} embedded>
            <ThreadListItems>
              {shown.map(request => (
                <ThreadListItem key={request.id} isActive={current === request.id} onClick={() => setSelected(request.id)}>
                  <RequestRow request={request} />
                </ThreadListItem>
              ))}
            </ThreadListItems>
          </ThreadList>
        )}
      </div>
      {compact || shown.length === 0 ? null : <KeyboardHints />}
    </div>
  );

  const detail =
    selected === 'new' ? (
      <NewRequestForm onCreated={request => setSelected(request.id)} onCancel={() => setSelected(undefined)} />
    ) : selected ? (
      <RequestThread
        key={selected}
        requestId={selected}
        hint={hint}
        compact={compact}
        onDone={() => moveOn(selected)}
        onOpenRequest={openRequest}
        onAddNote={requestId => {
          setNote({ draft: crypto.randomUUID(), requestId });
          setTab('notes');
        }}
      />
    ) : (
      <EmptyState
        variant="fill"
        iconSlot={<MessageSquareDashed />}
        titleSlot={t('panel.selectRequest')}
        descriptionSlot={
          <span className="flex items-center justify-center gap-1">
            <Kbd size="xs">J</Kbd>
            <Kbd size="xs">K</Kbd>
            {t('keys.move')}
          </span>
        }
      />
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
      <div ref={root} className="contents">
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
          <NotesView compact={compact} selection={note} onSelect={setNote} onOpenRequest={openRequest} />
        </TabContent>
      </div>
    </Tabs>
  );
}
