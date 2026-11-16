import {
  ChatAnnotationsProvider,
  ComposerAnnotations,
  formatAnnotatedMessage,
  TranscriptAnnotations,
  useChatAnnotations,
} from '@mastra/playground-ui/components/ai/annotations';
import { TranscriptDivider } from '@mastra/playground-ui/components/ai/transcript-divider';
import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Checkbox } from '@mastra/playground-ui/components/Checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mastra/playground-ui/components/Collapsible';
import { DisclosureChevron } from '@mastra/playground-ui/components/DisclosureChevron';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import { Combobox } from '@mastra/playground-ui/components/Combobox';
import type { ComboboxOption } from '@mastra/playground-ui/components/Combobox';
import {
  Composer,
  ComposerActions,
  ComposerBox,
  ComposerHeader,
  ComposerHeaderActions,
  ComposerHeaderRow,
  ComposerRing,
} from '@mastra/playground-ui/components/Composer';
import type { ComposerTone } from '@mastra/playground-ui/components/Composer';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Input } from '@mastra/playground-ui/components/Input';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { Message, MessageMetadata } from '@mastra/playground-ui/components/Message';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Shimmer } from '@mastra/playground-ui/components/Shimmer';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { StatusDot } from '@mastra/playground-ui/components/StatusIndicators';
import type { StatusPresentation } from '@mastra/playground-ui/components/StatusIndicators';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { MessageAttachments } from '@mastra/playground-ui/domains/chat/attachments/message-attachments';
import {
  Bot,
  Check,
  ExternalLink,
  Factory,
  Forward,
  MessageCircleQuestion,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { ComponentProps, DragEvent, FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  REQUEST_STATUSES,
  assistantUrl,
  catalogModelLabel,
  useAssistantApi,
  useAssistantModelCatalog,
  useAssistantFactories,
  useAssistantRequest,
  useAssistantRequests,
  usePostMessage,
  useRequestAction,
  useRequestWorkspace,
  useUpdateRequest,
} from './api';
import type {
  AssistantFile,
  AssistantMessage,
  AssistantRequest,
  AssistantWorkspaceSlot,
  FactoryAccessState,
  RequestStatus,
  TurnFailure,
} from './api';
import { AttachButton, DraftInput, PendingFiles, SendButton, ShortcutHint, useDraftFiles, useFilePicker } from './DraftComposer';
import { RequestTime } from './time';
import { eventLabel, PendingActionCard, TurnDetailsView } from './TurnTransparency';

export const STATUS_BADGE: Record<RequestStatus, BadgeVariant> = {
  new: 'info',
  waiting_factory: 'purple',
  waiting_me: 'warning',
  answered: 'success',
  closed: 'neutral',
};

/** A request's status; `unread` adds the dot that says the assistant answered since the person looked. */
export function StatusBadge({ status, unread = false }: { status: RequestStatus; unread?: boolean }) {
  const { t } = useTranslation('assistant');
  return (
    <Badge size="sm" variant={STATUS_BADGE[status]} {...(unread ? { indicator: 'dot' as const } : {})}>
      {t(`status.${status}`)}
    </Badge>
  );
}

/** A request's status as the kit's status dot: amber while someone has to act, green once answered. */
const STATUS_DOT: Record<RequestStatus, Omit<StatusPresentation, 'label' | 'description'>> = {
  new: { tone: 'neutral' },
  waiting_factory: { tone: 'progress', glyph: 'ring' },
  waiting_me: { tone: 'progress' },
  answered: { tone: 'success' },
  closed: { tone: 'neutral', glyph: 'ring' },
};

/** The status dot alone, beside a label that already says the status in words. */
export function RequestStatusDot({ status }: { status: RequestStatus }) {
  const { t } = useTranslation('assistant');
  const label = t(`status.${status}`);
  return <StatusDot status={status} presentation={() => ({ ...STATUS_DOT[status], label, description: label })} decorative />;
}

/** Where the composer sends what is typed: to the assistant, as a question to a Factory, or as a card handed to it. */
export type ComposerMode = 'assistant' | 'ask' | 'handOver';

const MODE_ICON: Record<ComposerMode, ReactNode> = {
  assistant: <Bot />,
  ask: <MessageCircleQuestion />,
  handOver: <Forward />,
};

/** Each mode wears its own ring tone, so the person sees at a glance where Enter will send. */
const MODE_TONE: Record<ComposerMode, ComposerTone> = { assistant: 'green', ask: 'purple', handOver: 'orange' };

export interface FactoryTarget {
  id: string;
  name: string;
}

type AttachmentParts = ComponentProps<typeof MessageAttachments>['parts'];

/** The request's files as the app's sent attachments: image previews, other files as cards opening the file. */
function Attachments({ files }: { files: AssistantFile[] }) {
  const api = useAssistantApi();
  if (files.length === 0) return null;
  const parts = files.map(file => ({ type: 'file', data: assistantUrl(api, file.contentUrl), mimeType: file.mime, filename: file.name }));
  return <MessageAttachments parts={parts as unknown as AttachmentParts} />;
}

export { ShortcutHint } from './DraftComposer';

// ─── Header ──────────────────────────────────────────────────────────────────

export interface TopicHandle {
  rename: () => void;
}

/** The topic, renamed in place (double-click, the pencil, or the menu's «Rename»): Enter saves, Escape leaves it. */
const Topic = forwardRef<TopicHandle, { request: AssistantRequest }>(({ request }, ref) => {
  const { t } = useTranslation('assistant');
  const update = useUpdateRequest();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  useImperativeHandle(ref, () => ({ rename: () => setDraft(request.topic) }), [request.topic]);
  const save = () => {
    const topic = draft?.replace(/\s+/g, ' ').trim();
    setDraft(undefined);
    if (topic && topic !== request.topic) update.mutate({ id: request.id, patch: { topic } });
  };

  if (draft !== undefined) {
    return (
      <form
        className="min-w-0 flex-1"
        onSubmit={event => {
          event.preventDefault();
          save();
        }}
      >
        <Input
          size="sm"
          autoFocus
          aria-label={t('thread.topic')}
          value={draft}
          maxLength={120}
          onChange={event => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDraft(undefined);
            }
          }}
        />
      </form>
    );
  }
  return (
    <div className="group flex min-w-0 flex-1 items-center gap-1">
      <Txt as="h3" variant="heading" className="truncate" title={request.topic} onDoubleClick={() => setDraft(request.topic)}>
        {request.topic}
      </Txt>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('thread.rename')}
        tooltip={t('thread.rename')}
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => setDraft(request.topic)}
      >
        <Pencil />
      </Button>
    </div>
  );
});
Topic.displayName = 'Topic';

/** The status as an inbox sets it: a select with all five, each with its dot. */
function StatusSelect({ request }: { request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const update = useUpdateRequest();
  return (
    <Select<RequestStatus> value={request.status} onValueChange={status => update.mutate({ id: request.id, patch: { status } })}>
      <SelectTrigger size="sm" variant="ghost" aria-label={t('status.label')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {REQUEST_STATUSES.map(status => (
          <SelectItem key={status} value={status}>
            <span className="flex items-center gap-2">
              <RequestStatusDot status={status} />
              {t(`status.${status}`)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Which Factory a question or a card goes to: the person's Factories, the page's own first. */
function FactoryPicker({
  access,
  target,
  onChange,
}: {
  access: FactoryAccessState | undefined;
  target: FactoryTarget | undefined;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const options: ComboboxOption[] = (access?.factories ?? []).map(factory => ({ value: factory.id, label: factory.name, start: <Factory /> }));
  const empty = !access ? t('panel.loading') : !access.connected ? t('actions.connectFirst') : t('actions.noFactories');
  return (
    <Combobox
      variant="ghost"
      size="sm"
      aria-label={t('actions.factory')}
      options={options}
      value={target?.id ?? ''}
      onValueChange={onChange}
      placeholder={
        <span className="flex items-center gap-1.5">
          <Factory aria-hidden className="size-3.5" />
          {access && !access.connected ? t('actions.notConnected') : t('actions.factory')}
        </span>
      }
      searchPlaceholder={t('actions.searchFactory')}
      emptyText={empty}
    />
  );
}

/** Who brought it and from where, when: the line under the topic. */
function MetaLine({ request }: { request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const factory = request.factory;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="assistant-meta-line">
      <span className="flex items-center gap-1.5">
        {request.fromName ? <Avatar name={request.fromName} size="xs" /> : null}
        <Txt as="span" variant="caption" tone="muted">
          {request.fromName ? t('thread.from', { name: request.fromName }) : t(`source.${request.source}`, { defaultValue: request.source })}
        </Txt>
      </span>
      {request.sourceUrl ? (
        <Button variant="link" size="sm" iconEnd={<ExternalLink />} render={<a href={request.sourceUrl} target="_blank" rel="noreferrer" />}>
          {t('thread.original')}
        </Button>
      ) : null}
      <Txt as="span" variant="caption" tone="muted">
        <RequestTime value={request.createdAt} label={t('thread.created')} />
      </Txt>
      {factory?.url ? (
        <Button variant="link" size="sm" iconEnd={<ExternalLink />} render={<a href={factory.url} />}>
          {factory.workItemId ? t('thread.factoryCard', { factory: factory.factoryName }) : t('thread.factorySession', { factory: factory.factoryName })}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The thread's header, as an inbox has it: the topic with its meta line, then the request's
 * properties (status, the target Factory) and the one primary action — Close (E) or Reopen.
 * Everything else sits in the «More» menu; on a phone the properties move there too.
 */
function ThreadHeader({
  request,
  compact,
  access,
  target,
  onTarget,
  onDone,
  onAddNote,
}: {
  request: AssistantRequest;
  compact: boolean;
  access: FactoryAccessState | undefined;
  target: FactoryTarget | undefined;
  onTarget: (id: string) => void;
  onDone?: () => void;
  onAddNote?: (requestId: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const { workspace } = useAssistantApi();
  const update = useUpdateRequest();
  const actions = useRequestAction(request.id);
  const topic = useRef<TopicHandle>(null);
  const closed = request.status === 'closed';
  const waitingOnQuestion = request.status === 'waiting_factory' && Boolean(request.factory?.sessionId);
  const setStatus = (status: RequestStatus) =>
    update.mutate({ id: request.id, patch: { status } }, status === 'closed' ? { onSuccess: () => onDone?.() } : undefined);
  const statusOptions = REQUEST_STATUSES.map(status => ({ value: status, label: t(`status.${status}`) }));
  const factoryOptions = (access?.factories ?? []).map(factory => ({ value: factory.id, label: factory.name }));

  const primary = closed ? (
    <Button size={compact ? 'icon-sm' : 'sm'} icon={<RotateCcw />} aria-label={t('actions.reopen')} onClick={() => setStatus('waiting_me')}>
      {compact ? <RotateCcw /> : t('actions.reopen')}
    </Button>
  ) : (
    <Button
      size={compact ? 'icon-sm' : 'sm'}
      variant="primary"
      icon={<Check />}
      aria-label={t('actions.close')}
      aria-keyshortcuts="E"
      tooltip={<ShortcutHint label={t('actions.closeHint')} keys={['E']} />}
      disabled={update.isPending}
      onClick={() => setStatus('closed')}
    >
      {compact ? <Check /> : t('actions.close')}
    </Button>
  );

  const more = (
    <DropdownMenu>
      <DropdownMenu.Trigger variant="ghost" size="icon-sm" aria-label={t('actions.more')} tooltip={t('actions.more')}>
        <MoreHorizontal />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {compact ? (
          <>
            <DropdownMenu.RadioSub label={t('status.label')} options={statusOptions} value={request.status} onValueChange={setStatus} />
            {factoryOptions.length > 0 ? (
              <DropdownMenu.RadioSub
                label={t('actions.factory')}
                icon={<Factory />}
                options={factoryOptions}
                value={target?.id ?? ''}
                onValueChange={onTarget}
              />
            ) : null}
            <DropdownMenu.Separator />
          </>
        ) : null}
        <DropdownMenu.Item onSelect={() => topic.current?.rename()}>
          <Pencil />
          {t('thread.rename')}
        </DropdownMenu.Item>
        {onAddNote ? (
          <DropdownMenu.Item onSelect={() => onAddNote(request.id)}>
            <NotebookPen />
            {t('thread.addNote')}
          </DropdownMenu.Item>
        ) : null}
        {waitingOnQuestion ? (
          <DropdownMenu.Item onSelect={() => actions.checkAnswer.mutate()}>
            <RefreshCw />
            {t('actions.checkAnswer')}
          </DropdownMenu.Item>
        ) : null}
        {request.sourceUrl ? (
          <DropdownMenu.Item render={<a href={request.sourceUrl} target="_blank" rel="noreferrer" />}>
            <ExternalLink />
            {t('actions.openOriginal')}
          </DropdownMenu.Item>
        ) : null}
        {request.factory?.url ? (
          <DropdownMenu.Item render={<a href={request.factory.url} />}>
            <Factory />
            {t('actions.openInFactory', { factory: request.factory.factoryName })}
          </DropdownMenu.Item>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu>
  );

  return (
    <ChatShell.Bar data-testid="assistant-topic-line" className="flex flex-col gap-1 px-3 pt-2 pb-2">
      <div className="flex min-w-0 items-center gap-2">
        <Topic ref={topic} request={request} />
        <div className="flex shrink-0 items-center gap-1" role="toolbar" aria-label={t('actions.label')}>
          {workspace ? <workspace.Toggle /> : null}
          {primary}
          {more}
        </div>
      </div>
      <MetaLine request={request} />
      {compact ? null : (
        <div className="-ml-2 flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label={t('thread.properties')}>
          <StatusSelect request={request} />
          <FactoryPicker access={access} target={target} onChange={onTarget} />
          {waitingOnQuestion ? (
            <Button size="sm" variant="ghost" icon={<RefreshCw />} disabled={actions.checkAnswer.isPending} onClick={() => actions.checkAnswer.mutate()}>
              {t('actions.checkAnswer')}
            </Button>
          ) : null}
        </div>
      )}
      {actions.checkAnswer.data && !actions.checkAnswer.data.answered ? (
        <Txt as="p" variant="caption" tone="muted" role="status">
          {t('actions.noAnswerYet')}
        </Txt>
      ) : null}
      {[update, actions.checkAnswer].map((mutation, index) =>
        mutation.isError ? (
          <Notice key={index} variant="destructive">
            {mutation.error.message}
          </Notice>
        ) : null,
      )}
    </ChatShell.Bar>
  );
}

// ─── Thread ──────────────────────────────────────────────────────────────────

/** What a thread entry can do beyond showing itself: open another request, run the agent again. */
interface ThreadEntryActions {
  /** Opens another request of the person's (the one a source request continues). */
  onOpenRequest?: (id: string) => void;
  /** Runs the agent on what it has not answered; absent when that is not possible now. */
  onAnalyse?: () => void;
  analysing?: boolean;
}

/** `continues:<id>`: this request picks up a source thread whose earlier request was closed. */
function ContinuesLine({ previousId, onOpenRequest }: { previousId: string; onOpenRequest?: (id: string) => void }) {
  const { t } = useTranslation('assistant');
  const previous = useAssistantRequests().data?.find(request => request.id === previousId);
  const label = previous ? t('thread.continues', { topic: previous.topic }) : t('thread.continuesUnknown');
  return (
    <TranscriptDivider label={label}>
      {onOpenRequest ? (
        <Button variant="ghost" size="sm" onClick={() => onOpenRequest(previousId)}>
          {t('thread.openPrevious')}
        </Button>
      ) : null}
    </TranscriptDivider>
  );
}

/**
 * An `event` entry: `asked:<Factory>\n<question>`, `handed:<Factory>[\n<note>][\nfiles_failed\n…]`,
 * `continues:<request id>`, or `not_analysed:limit` (a source message kept but not read by the agent).
 */
function EventLine({ message, onOpenRequest, onAnalyse, analysing }: { message: AssistantMessage } & ThreadEntryActions) {
  const { t } = useTranslation('assistant');
  if (message.text.startsWith('continues:')) {
    return <ContinuesLine previousId={message.text.slice('continues:'.length).trim()} onOpenRequest={onOpenRequest} />;
  }
  const known = eventLabel(message.text, t as never);
  if (known) {
    return (
      <>
        <TranscriptDivider label={known.label} />
        {known.body ? (
          <Txt as="p" variant="caption" tone="muted" className="line-clamp-3 text-center whitespace-pre-line">
            {known.body}
          </Txt>
        ) : null}
      </>
    );
  }
  if (message.text.startsWith('not_analysed:')) {
    return (
      <TranscriptDivider label={t('thread.notAnalysed')}>
        {onAnalyse ? (
          <Button variant="ghost" size="sm" icon={<Sparkles />} disabled={analysing} onClick={onAnalyse}>
            {t('thread.analyse')}
          </Button>
        ) : null}
      </TranscriptDivider>
    );
  }
  const [head = '', ...rest] = message.text.split('\n');
  const [kind, ...name] = head.split(':');
  const factory = name.join(':');
  const failedAt = rest.indexOf('files_failed');
  const said = (failedAt >= 0 ? rest.slice(0, failedAt) : rest).join('\n').trim();
  return (
    <>
      <TranscriptDivider label={kind === 'asked' ? t('thread.askedEvent', { factory }) : t('thread.handedEvent', { factory })} />
      {said ? (
        <Txt as="p" variant="caption" tone="muted" className="line-clamp-3 text-center whitespace-pre-line">
          {said}
        </Txt>
      ) : null}
      {failedAt >= 0 ? (
        <Notice variant="warning">
          {t('thread.filesFailed')} {rest.slice(failedAt + 1).join('; ')}
        </Notice>
      ) : null}
    </>
  );
}

/**
 * A message read from a source (a colleague's in ClickUp): an incoming message from that person,
 * as a helpdesk shows a customer's — their avatar and name, on the left — never as the assistant's reply.
 */
function SourceEntry({ message, files }: { message: AssistantMessage; files: AssistantFile[] }) {
  const { t } = useTranslation('assistant');
  const name = message.fromName?.trim() || t('thread.someone');
  return (
    <Message
      from="assistant"
      data-author="source"
      aria-label={t('thread.sourceFrom', { name })}
      className="my-3 flex w-fit max-w-[85%] items-start gap-2"
      avatar={<Avatar name={name} size="sm" />}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <Txt as="span" variant="label">
            {name}
          </Txt>
          <Txt as="span" variant="caption" tone="muted">
            <RequestTime value={message.createdAt} />
          </Txt>
        </span>
        {files.length ? <Attachments files={files} /> : null}
        {message.text ? (
          <div className="border-border min-w-0 rounded-xl border px-4 py-2 [&>:last-child]:mb-0">
            <ThreadMarkdown text={message.text} />
          </div>
        ) : null}
      </div>
    </Message>
  );
}

/** The app's file links when it gives the thread its Files (the sessions' own), else plain Markdown. */
function ThreadMarkdown({ text }: { text: string }) {
  const { workspace } = useAssistantApi();
  return workspace ? <LinkedMarkdown text={text} useMarkdown={workspace.useMarkdown} /> : <MarkdownRenderer>{text}</MarkdownRenderer>;
}

function LinkedMarkdown({ text, useMarkdown }: { text: string; useMarkdown: AssistantWorkspaceSlot['useMarkdown'] }) {
  const overrides = useMarkdown();
  return <MarkdownRenderer {...overrides}>{text}</MarkdownRenderer>;
}

function ThreadEntry({ message, files, ...actions }: { message: AssistantMessage; files: AssistantFile[] } & ThreadEntryActions) {
  const { t } = useTranslation('assistant');
  if (message.author === 'event') return <EventLine message={message} {...actions} />;
  const own = files.filter(file => message.fileIds.includes(file.id));
  if (message.author === 'source') return <SourceEntry message={message} files={own} />;
  const label = message.author === 'person' ? t('thread.you') : message.author === 'factory' ? t('thread.factory') : t('thread.agent');
  return (
    <Message
      from={message.author === 'person' ? 'user' : 'assistant'}
      aria-label={label}
      attachments={own.length ? <Attachments files={own} /> : undefined}
      footer={
        message.author === 'factory' ? (
          <MessageMetadata>{label}</MessageMetadata>
        ) : message.author === 'agent' && message.details ? (
          <TurnDetailsView details={message.details} />
        ) : undefined
      }
    >
      {message.text ? <ThreadMarkdown text={message.text} /> : null}
    </Message>
  );
}

// ─── A failed turn ───────────────────────────────────────────────────────────

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  cerebras: 'Cerebras',
  togetherai: 'Together AI',
};

/**
 * The model's name as the organization's catalog gives it (`useModelLabel`); without the catalog,
 * `xai/grok-4.5` → `xAI · grok-4.5`, `claude-code:claude-opus-5-5` → `claude-code · claude-opus-5-5`.
 */
export function useModelLabel(): (modelId: string) => string {
  const catalog = useAssistantModelCatalog().data;
  return modelId => catalogModelLabel(catalog, modelId) ?? modelLabel(modelId);
}

/** `xai/grok-4.5` → `xAI · grok-4.5`, as the thread names the model that failed (no catalog at hand). */
export function modelLabel(modelId: string): string {
  const colon = modelId.indexOf(':');
  if (colon > 0 && (modelId.indexOf('/') < 0 || colon < modelId.indexOf('/'))) return `${modelId.slice(0, colon)} · ${modelId.slice(colon + 1)}`;
  const slash = modelId.indexOf('/');
  if (slash < 0) return modelId;
  const provider = modelId.slice(0, slash);
  return `${PROVIDER_NAMES[provider] ?? provider} · ${modelId.slice(slash + 1)}`;
}

/** Failures another model would get past: the fix is to pick one in Account › Assistant. */
const MODEL_FIXES = new Set<TurnFailure['kind']>(['rate_limit', 'auth', 'model_not_found', 'overloaded']);

/**
 * Why the agent could not answer, as a person can act on it: the provider and model named, what
 * went wrong in words, the fix — try again, or pick another model — and the provider's raw words
 * kept under «Details». Never another model behind the person's back.
 */
function TurnFailureNotice({ failure, request }: { failure: TurnFailure; request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const { settingsHref } = useAssistantApi();
  const actions = useRequestAction(request.id);
  const label = useModelLabel();
  const model = failure.modelId ? label(failure.modelId) : t('failure.defaultModel');
  const headline = t(`failure.${failure.kind}.title`, { model });
  const fix = t(`failure.${failure.kind}.fix`);
  const canRetry = request.status !== 'closed' && !request.analysing;
  const pickModel = MODEL_FIXES.has(failure.kind) || failure.kind === 'unknown';
  return (
    <div role="alert" data-testid="assistant-turn-failure">
      <Notice
        variant="destructive"
        action={
          <span className="flex flex-wrap items-center gap-3">
            {canRetry ? (
              <Notice.Button icon={<RotateCcw />} disabled={actions.retry.isPending} onClick={() => actions.retry.mutate()}>
                {t('failure.retry')}
              </Notice.Button>
            ) : null}
            {pickModel && settingsHref ? (
              <Notice.Button icon={<Settings2 />} render={<a href={settingsHref} />}>
                {t('failure.pickModel')}
              </Notice.Button>
            ) : null}
          </span>
        }
      >
        {/* The headline wraps (a title would truncate it on a phone). */}
        <Txt as="span" variant="label">
          {headline}
        </Txt>
        <span>{fix}</span>
        {actions.retry.isError ? <span>{actions.retry.error.message}</span> : null}
        {failure.detail ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm">
              <DisclosureChevron />
              {t('failure.details')}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap" data-testid="assistant-failure-detail">
                {failure.status ? `HTTP ${failure.status}\n` : ''}
                {failure.detail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </Notice>
    </div>
  );
}

// ─── Composer ────────────────────────────────────────────────────────────────

/**
 * The person's reply, with a mode, as an inbox's reply/note switch: to the assistant (files and
 * screenshots too), a question to the chosen Factory, or the request handed to it as a card with
 * what is typed as the note. Enter sends in every mode.
 */
/** Workspace files the hand-over takes along to the card (as the card's attachments), picked by the person. */
function HandOverFiles({ requestId, picked, onChange }: { requestId: string; picked: string[]; onChange: (paths: string[]) => void }) {
  const { t } = useTranslation('assistant');
  const workspace = useRequestWorkspace(requestId);
  const files = (workspace.data?.files ?? []).filter(entry => entry.type === 'file');
  return (
    <div role="group" className="flex min-w-0 flex-col gap-1" aria-label={t('handOverFiles.label')}>
      <Txt as="span" variant="caption" tone="muted">
        {t('handOverFiles.label')}
      </Txt>
      {files.length === 0 ? (
        <Txt as="span" variant="caption" tone="muted">
          {t('handOverFiles.none')}
        </Txt>
      ) : (
        <span className="flex max-h-24 flex-wrap gap-x-3 gap-y-1 overflow-auto">
          {files.map(file => (
            <label key={file.path} className="flex items-center gap-1.5 text-xs">
              <Checkbox
                checked={picked.includes(file.path)}
                onCheckedChange={checked => onChange(checked ? [...picked, file.path] : picked.filter(path => path !== file.path))}
                aria-label={file.path}
              />
              <span className="font-mono">{file.path}</span>
            </label>
          ))}
        </span>
      )}
    </div>
  );
}

function ReplyComposer({
  request,
  compact,
  access,
  target,
}: {
  request: AssistantRequest;
  compact: boolean;
  access: FactoryAccessState | undefined;
  target: FactoryTarget | undefined;
}) {
  const { t } = useTranslation('assistant');
  const post = usePostMessage(request.id);
  const actions = useRequestAction(request.id);
  const update = useUpdateRequest();
  const [mode, setMode] = useState<ComposerMode>('assistant');
  const [text, setText] = useState('');
  const { files, add: addFiles, removeAt, clear } = useDraftFiles();
  const picker = useFilePicker(addFiles);
  const [handOverFiles, setHandOverFiles] = useState<string[]>([]);
  const { workspace: workspaceSlot } = useAssistantApi();

  if (request.status === 'closed') {
    return (
      <Notice variant="info">
        <span className="flex flex-wrap items-center justify-between gap-2">
          {t('thread.closedNotice')}
          <Button size="sm" icon={<RotateCcw />} onClick={() => update.mutate({ id: request.id, patch: { status: 'waiting_me' } })}>
            {t('actions.reopen')}
          </Button>
        </span>
      </Notice>
    );
  }

  const handedOver = Boolean(request.factory?.workItemId);
  const effective: ComposerMode = mode === 'handOver' && handedOver ? 'assistant' : mode;
  const toFactory = effective !== 'assistant';
  const mutation = effective === 'ask' ? actions.ask : effective === 'handOver' ? actions.handOver : post;
  const factoryReady = Boolean(access?.connected && target);
  const busy = mutation.isPending || (effective === 'assistant' && request.analysing);
  const { annotations, takeAnnotations, restoreAnnotations } = useChatAnnotations();
  const canSend =
    !busy && (toFactory ? factoryReady : text.trim().length > 0 || files.length > 0 || annotations.length > 0);
  const reset = () => {
    setText('');
    clear();
    setHandOverFiles([]);
    setMode('assistant');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    // Passages the person marked in the thread go first, as in a Factory chat: quoted, each with its comment.
    const sent = takeAnnotations();
    const message = formatAnnotatedMessage(text, sent);
    const typed = message.trim();
    const done = { onSuccess: reset, onError: () => restoreAnnotations(sent) };
    if (effective === 'assistant') post.mutate({ text: message, files }, done);
    else if (effective === 'ask') actions.ask.mutate({ factoryId: target!.id, ...(typed ? { question: typed } : {}) }, done);
    else
      actions.handOver.mutate(
        { factoryId: target!.id, ...(typed ? { note: typed } : {}), ...(handOverFiles.length ? { workspaceFiles: handOverFiles } : {}) },
        done,
      );
  };
  const drop = (event: DragEvent<HTMLFormElement>) => {
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length === 0 || toFactory) return;
    event.preventDefault();
    addFiles(dropped);
  };
  const factoryName = target?.name ?? t('actions.factory');
  const placeholder =
    effective === 'ask'
      ? t('composer.askPlaceholder', { factory: factoryName })
      : effective === 'handOver'
        ? t('composer.handOverPlaceholder', { factory: factoryName })
        : t('thread.reply');
  const modes: ComposerMode[] = ['assistant', 'ask', 'handOver'];
  const notice = toFactory
    ? !access
      ? null
      : !access.connected
        ? t('actions.connectFirst')
        : access.factories.length === 0
          ? t('actions.noFactories')
          : null
    : null;

  return (
    <Composer onSubmit={submit} onDrop={drop} onDragOver={event => event.preventDefault()} aria-label={t('thread.reply')}>
      <ComposerHeader>
        <ComposerHeaderRow>
          <SegmentedControl<ComposerMode> size="sm" iconOnly={compact} aria-label={t('composer.mode')} value={effective} onValueChange={setMode}>
            {modes.map(item => (
              <SegmentedControlItem
                key={item}
                value={item}
                disabled={item === 'handOver' && handedOver}
                {...(compact ? { 'aria-label': t(`composer.modes.${item}`) } : {})}
              >
                {MODE_ICON[item]}
                {compact ? null : t(`composer.modes.${item}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {compact ? (
            <Txt as="span" variant="caption" tone="muted" className="truncate">
              {t(`composer.modes.${effective}`)}
            </Txt>
          ) : null}
          {toFactory && target ? (
            <ComposerHeaderActions>
              <Txt as="span" variant="caption" tone="muted" className="flex items-center gap-1">
                <Factory aria-hidden className="size-3.5" />
                {target.name}
              </Txt>
            </ComposerHeaderActions>
          ) : null}
        </ComposerHeaderRow>
        {notice ? <ComposerHeaderRow>{notice}</ComposerHeaderRow> : null}
        {effective === 'handOver' && workspaceSlot ? (
          <ComposerHeaderRow>
            <HandOverFiles requestId={request.id} picked={handOverFiles} onChange={setHandOverFiles} />
          </ComposerHeaderRow>
        ) : null}
        {mutation.isError ? <ComposerHeaderRow tone="destructive">{mutation.error.message}</ComposerHeaderRow> : null}
      </ComposerHeader>
      <ComposerRing busy={busy} tone={MODE_TONE[effective]}>
        <ComposerBox>
          <ComposerAnnotations />
          {toFactory ? null : <PendingFiles files={files} onRemove={removeAt} />}
          <DraftInput
            aria-label={placeholder}
            placeholder={placeholder}
            value={text}
            onChange={event => setText(event.target.value)}
            {...(toFactory ? {} : { onFiles: addFiles })}
          />
          {picker.input}
          <ComposerActions className="flex-nowrap">
            <Txt as="span" variant="caption" tone="muted" className="min-w-0 self-center truncate">
              {toFactory ? t('composer.factoryHint') : null}
            </Txt>
            <ButtonsGroup size="sm" className="ml-auto shrink-0 self-end" aria-label={t('composer.actions')}>
              {toFactory ? null : <AttachButton onClick={picker.open} />}
              {toFactory ? (
                <Button type="submit" size="sm" variant="primary" icon={MODE_ICON[effective]} disabled={!canSend}>
                  {effective === 'ask' ? t('composer.sendAsk', { factory: factoryName }) : t('composer.sendHandOver', { factory: factoryName })}
                </Button>
              ) : (
                <SendButton disabled={!canSend} />
              )}
            </ButtonsGroup>
          </ComposerActions>
        </ComposerBox>
      </ComposerRing>
    </Composer>
  );
}

/** The Factory a question or card goes to: the one picked, else the request's own, the page's, the first reachable. */
function resolveTarget(
  access: FactoryAccessState | undefined,
  picked: string,
  request: AssistantRequest,
  hint: FactoryTarget | undefined,
): FactoryTarget | undefined {
  const reachable = access?.factories ?? [];
  for (const id of [picked, request.factory?.factoryId, hint?.id]) {
    const found = id ? reachable.find(factory => factory.id === id) : undefined;
    if (found) return found;
  }
  return reachable[0];
}

/**
 * An open request, laid out as an inbox thread: the header (topic, who and when, status, target
 * Factory, Close), the transcript, and the composer docked below with its send mode.
 */
export function RequestThread({
  requestId,
  hint,
  compact = false,
  onDone,
  onOpenRequest,
  onAddNote,
}: {
  requestId: string;
  hint?: FactoryTarget;
  compact?: boolean;
  /** Called once the person closed the request here, so the panel can move on to the next one. */
  onDone?: () => void;
  /** Opens another request (the earlier one a source request continues). */
  onOpenRequest?: (id: string) => void;
  /** Starts a note about this request in the Notes tab. */
  onAddNote?: (requestId: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const api = useAssistantApi();
  const view = useAssistantRequest(requestId);
  const factories = useAssistantFactories();
  const actions = useRequestAction(requestId);
  const [picked, setPicked] = useState('');
  if (view.isError) return <Notice variant="destructive">{view.error.message}</Notice>;
  if (!view.data) {
    return (
      <div className="flex flex-col gap-3 p-4" role="status" aria-label={t('panel.loading')}>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="ml-auto h-10 w-1/2" />
      </div>
    );
  }
  const { request, messages, files } = view.data;
  const target = resolveTarget(factories.data, picked, request, hint);
  // «Analyse» on a message the hourly limit left unread: only while nothing after it was answered.
  const lastAgent = messages.findLastIndex(message => message.author === 'agent');
  const canAnalyse = request.status !== 'closed' && !request.analysing;
  const workspace = api.workspace;
  const shell = (
    // Marked passages belong to this thread: the provider lives (and goes) with it.
    <ChatAnnotationsProvider>
      <ChatShell
        data-testid="assistant-thread"
        className="flex-1 [--chat-surface:var(--assistant-surface,var(--color-card))]"
        scroller={{ autoScroll: true, defaultScrollPosition: 'end' }}
      >
        <ThreadHeader
          request={request}
          compact={compact}
          access={factories.data}
          target={target}
          onTarget={setPicked}
          onDone={onDone}
          onAddNote={onAddNote}
        />
        <ChatShell.Stage>
          <ChatShell.Viewport>
            <ChatShell.Content role="log" aria-label={t('thread.label')} className="pt-4">
              <ChatShell.Transcript>
                <TranscriptAnnotations />
                {messages.map((message, index) => (
                  <ThreadEntry
                    key={message.id}
                    message={message}
                    files={files}
                    onOpenRequest={onOpenRequest}
                    analysing={actions.retry.isPending}
                    {...(canAnalyse && index > lastAgent ? { onAnalyse: () => actions.retry.mutate() } : {})}
                  />
                ))}
                {request.pendingAction ? <PendingActionCard request={request} action={request.pendingAction} /> : null}
                {request.analysing ? (
                  <Message from="assistant" pending>
                    <Txt as="p" variant="body-sm" tone="muted" role="status">
                      <Shimmer>{t('thread.analysing')}</Shimmer>
                    </Txt>
                  </Message>
                ) : null}
                {request.lastError && !request.analysing ? <TurnFailureNotice failure={request.lastError} request={request} /> : null}
              </ChatShell.Transcript>
            </ChatShell.Content>
            <ChatShell.Dock>
              <ChatShell.ScrollButton />
              <ChatShell.Column>
                <ReplyComposer request={request} compact={compact} access={factories.data} target={target} />
              </ChatShell.Column>
            </ChatShell.Dock>
          </ChatShell.Viewport>
        </ChatShell.Stage>
      </ChatShell>
    </ChatAnnotationsProvider>
  );
  if (!workspace) return shell;
  // The request's folder in the app's Files (the sessions' panel); read again whenever the thread moves.
  const revision = `${messages.length}:${request.analysing}:${request.updatedAt}`;
  return (
    <workspace.Thread requestId={request.id} revision={revision}>
      {shell}
    </workspace.Thread>
  );
}
