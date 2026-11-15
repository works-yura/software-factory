import { TranscriptDivider } from '@mastra/playground-ui/components/ai/transcript-divider';
import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import { Composer, ComposerActions, ComposerBox, ComposerHeader, ComposerInput, ComposerRing } from '@mastra/playground-ui/components/Composer';
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@mastra/playground-ui/components/Dialog';
import { EntityHeader } from '@mastra/playground-ui/components/EntityHeader';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { Message, MessageMetadata } from '@mastra/playground-ui/components/Message';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Shimmer } from '@mastra/playground-ui/components/Shimmer';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { TextAndIcon } from '@mastra/playground-ui/components/Text';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { MessageAttachments } from '@mastra/playground-ui/domains/chat/attachments/message-attachments';
import { ArrowUp, ExternalLink, Inbox, Paperclip, RefreshCw, User } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { ComponentProps, DragEvent, FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { assistantUrl, useAssistantApi, useAssistantFactories, useAssistantRequest, usePostMessage, useRequestAction } from './api';
import type { AssistantFile, AssistantMessage, AssistantRequest, RequestStatus } from './api';
import { PendingFiles, pastedFiles } from './NewRequestForm';

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

type AttachmentParts = ComponentProps<typeof MessageAttachments>['parts'];

/** The request's files as the app's sent attachments: image previews, other files as cards opening the file. */
function Attachments({ files }: { files: AssistantFile[] }) {
  const api = useAssistantApi();
  if (files.length === 0) return null;
  const parts = files.map(file => ({ type: 'file', data: assistantUrl(api, file.contentUrl), mimeType: file.mime, filename: file.name }));
  return <MessageAttachments parts={parts as unknown as AttachmentParts} />;
}

/** The topic line: what, from whom, the original, and the Factory and card once they are linked. */
function TopicLine({ request }: { request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const factory = request.factory;
  return (
    <ChatShell.Bar data-testid="assistant-topic-line">
      <EntityHeader icon={<Inbox />} title={request.topic}>
        <StatusBadge status={request.status} />
      </EntityHeader>
      <div className="flex flex-wrap items-center gap-x-3 px-3">
        {request.fromName ? (
          <TextAndIcon>
            <User aria-hidden />
            {t('thread.from', { name: request.fromName })}
          </TextAndIcon>
        ) : null}
        {request.sourceUrl ? (
          <Button variant="link" size="sm" iconEnd={<ExternalLink />} render={<a href={request.sourceUrl} target="_blank" rel="noreferrer" />}>
            {t('thread.original')}
          </Button>
        ) : null}
        {factory?.url ? (
          <Button variant="link" size="sm" render={<a href={factory.url} />}>
            {factory.workItemId ? t('thread.factoryCard', { factory: factory.factoryName }) : t('thread.factorySession', { factory: factory.factoryName })}
          </Button>
        ) : null}
      </div>
    </ChatShell.Bar>
  );
}

/** An `event` entry: `asked:<Factory>\n<question>` or `handed:<Factory>[\nfiles_failed\n…]`. */
function EventLine({ message }: { message: AssistantMessage }) {
  const { t } = useTranslation('assistant');
  const [head = '', ...rest] = message.text.split('\n');
  const [kind, ...name] = head.split(':');
  const factory = name.join(':');
  const failedAt = rest.indexOf('files_failed');
  return (
    <>
      <TranscriptDivider label={kind === 'asked' ? t('thread.askedEvent', { factory }) : t('thread.handedEvent', { factory })} />
      {failedAt >= 0 ? (
        <Notice variant="warning">
          {t('thread.filesFailed')} {rest.slice(failedAt + 1).join('; ')}
        </Notice>
      ) : null}
    </>
  );
}

function ThreadEntry({ message, files }: { message: AssistantMessage; files: AssistantFile[] }) {
  const { t } = useTranslation('assistant');
  if (message.author === 'event') return <EventLine message={message} />;
  const own = files.filter(file => message.fileIds.includes(file.id));
  const label = message.author === 'person' ? t('thread.you') : message.author === 'factory' ? t('thread.factory') : t('thread.agent');
  return (
    <Message
      from={message.author === 'person' ? 'user' : 'assistant'}
      aria-label={label}
      attachments={own.length ? <Attachments files={own} /> : undefined}
      footer={message.author === 'factory' ? <MessageMetadata>{label}</MessageMetadata> : undefined}
    >
      {message.text ? <MarkdownRenderer>{message.text}</MarkdownRenderer> : null}
    </Message>
  );
}

function FactoryDialog({
  kind,
  request,
  hint,
  onDone,
}: {
  kind: 'ask' | 'handOver';
  request: AssistantRequest;
  hint?: { id: string; name: string };
  onDone: () => void;
}) {
  const { t } = useTranslation('assistant');
  const factories = useAssistantFactories();
  const actions = useRequestAction(request.id);
  const mutation = kind === 'ask' ? actions.ask : actions.handOver;
  const reachable = factories.data?.factories ?? [];
  const [factoryId, setFactoryId] = useState<string>('');
  const [text, setText] = useState('');
  const ids = { factory: useId(), text: useId() };
  const label = kind === 'ask' ? t('actions.ask') : t('actions.handOver');
  const chosen = factoryId || (hint && reachable.some(factory => factory.id === hint.id) ? hint.id : reachable[0]?.id) || '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    const input =
      kind === 'ask'
        ? { factoryId: chosen, ...(text.trim() ? { question: text.trim() } : {}) }
        : { factoryId: chosen, ...(text.trim() ? { title: text.trim() } : {}) };
    mutation.mutate(input as never, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} aria-label={label}>
      <DialogHeader>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>{request.topic}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {factories.isError ? <Notice variant="destructive">{factories.error.message}</Notice> : null}
        {factories.data && !factories.data.connected ? <Notice variant="info">{t('actions.connectFirst')}</Notice> : null}
        {factories.data?.connected && reachable.length === 0 ? <Notice variant="info">{t('actions.noFactories')}</Notice> : null}
        {reachable.length > 0 ? (
          <>
            <Field>
              <FieldLabel htmlFor={ids.factory}>{t('actions.factory')}</FieldLabel>
              <Select value={chosen} onValueChange={setFactoryId}>
                <SelectTrigger id={ids.factory} aria-label={t('actions.factory')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {reachable.map(factory => (
                    <SelectItem key={factory.id} value={factory.id}>
                      {factory.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={ids.text}>{kind === 'ask' ? t('actions.question') : t('actions.title')}</FieldLabel>
              {kind === 'ask' ? (
                <Textarea id={ids.text} rows={4} value={text} placeholder={t('actions.questionPlaceholder')} onChange={event => setText(event.target.value)} />
              ) : (
                <Input id={ids.text} value={text} placeholder={request.topic} onChange={event => setText(event.target.value)} />
              )}
            </Field>
          </>
        ) : null}
        {mutation.isError ? <Notice variant="destructive">{mutation.error.message}</Notice> : null}
      </DialogBody>
      <DialogFooter>
        <DialogCancel>{t('actions.cancel')}</DialogCancel>
        <DialogAction type="submit" disabled={!chosen || mutation.isPending}>
          {kind === 'ask' ? t('actions.confirmAsk') : t('actions.confirmHandOver')}
        </DialogAction>
      </DialogFooter>
    </form>
  );
}

function FactoryAction({ kind, request, hint }: { kind: 'ask' | 'handOver'; request: AssistantRequest; hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm">{kind === 'ask' ? t('actions.ask') : t('actions.handOver')}</Button>} />
      <DialogContent>{open ? <FactoryDialog kind={kind} request={request} hint={hint} onDone={() => setOpen(false)} /> : null}</DialogContent>
    </Dialog>
  );
}

function ThreadActions({ request, hint }: { request: AssistantRequest; hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const actions = useRequestAction(request.id);
  if (request.status === 'closed') return null;
  const waitingOnQuestion = request.status === 'waiting_factory' && Boolean(request.factory?.sessionId);
  return (
    <ChatShell.Bar className="flex flex-col gap-2 px-3 pb-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t('actions.label')}>
        <ButtonsGroup>
          <FactoryAction kind="ask" request={request} hint={hint} />
          {!request.factory?.workItemId ? <FactoryAction kind="handOver" request={request} hint={hint} /> : null}
        </ButtonsGroup>
        {hint && !request.factory ? (
          <Txt as="span" variant="caption" tone="muted">
            {t('actions.hint', { factory: hint.name })}
          </Txt>
        ) : null}
        {waitingOnQuestion ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw />} disabled={actions.checkAnswer.isPending} onClick={() => actions.checkAnswer.mutate()}>
            {t('actions.checkAnswer')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={actions.close.isPending} onClick={() => actions.close.mutate()}>
          {t('actions.close')}
        </Button>
      </div>
      {actions.checkAnswer.data && !actions.checkAnswer.data.answered ? (
        <Txt as="p" variant="caption" tone="muted" role="status">
          {t('actions.noAnswerYet')}
        </Txt>
      ) : null}
      {[actions.close, actions.checkAnswer].map((mutation, index) =>
        mutation.isError ? (
          <Notice key={index} variant="destructive">
            {mutation.error.message}
          </Notice>
        ) : null,
      )}
    </ChatShell.Bar>
  );
}

/** The person's reply: the app's composer — Enter sends, Ctrl+V pastes screenshots, files drop onto it. */
function ReplyComposer({ request }: { request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const post = usePostMessage(request.id);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  if (request.status === 'closed') return <Notice variant="info">{t('thread.closedNotice')}</Notice>;
  const busy = post.isPending || request.analysing;
  const canSend = (text.trim().length > 0 || files.length > 0) && !busy;
  const addFiles = (added: File[]) => setFiles(current => [...current, ...added]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    post.mutate(
      { text, files },
      {
        onSuccess: () => {
          setText('');
          setFiles([]);
        },
      },
    );
  };
  const drop = (event: DragEvent<HTMLFormElement>) => {
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    event.preventDefault();
    addFiles(dropped);
  };
  return (
    <Composer onSubmit={submit} onDrop={drop} onDragOver={event => event.preventDefault()} aria-label={t('thread.reply')}>
      <ComposerHeader open={post.isError}>{post.isError ? <Notice variant="destructive">{post.error.message}</Notice> : null}</ComposerHeader>
      <ComposerRing busy={busy}>
        <ComposerBox>
          <PendingFiles files={files} onRemove={index => setFiles(current => current.filter((_, at) => at !== index))} />
          <ComposerInput
            aria-label={t('thread.reply')}
            placeholder={t('thread.reply')}
            value={text}
            onChange={event => setText(event.target.value)}
            onPaste={event => {
              const pasted = pastedFiles(event);
              if (pasted.length === 0) return;
              event.preventDefault();
              addFiles(pasted);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label={t('thread.attach')}
            onChange={event => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <ComposerActions>
            <Button type="button" size="icon-sm" aria-label={t('thread.attach')} tooltip={t('thread.attach')} onClick={() => picker.current?.click()}>
              <Paperclip />
            </Button>
            <Button type="submit" size="icon-sm" variant="primary" aria-label={t('thread.send')} disabled={!canSend}>
              <ArrowUp />
            </Button>
          </ComposerActions>
        </ComposerBox>
      </ComposerRing>
    </Composer>
  );
}

/** An open request, laid out as the app's session chat: topic and actions above, the thread, the composer docked below. */
export function RequestThread({ requestId, hint }: { requestId: string; hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const view = useAssistantRequest(requestId);
  if (view.isError) return <Notice variant="destructive">{view.error.message}</Notice>;
  if (!view.data) {
    return (
      <div className="flex flex-col gap-3 p-4" role="status" aria-label={t('panel.loading')}>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="ml-auto h-10 w-1/2" />
      </div>
    );
  }
  const { request, messages, files } = view.data;
  return (
    <ChatShell
      data-testid="assistant-thread"
      className="flex-1 [--chat-surface:var(--assistant-surface,var(--color-card))]"
      scroller={{ autoScroll: true, defaultScrollPosition: 'end' }}
    >
      <TopicLine request={request} />
      <ThreadActions request={request} hint={hint} />
      <ChatShell.Stage>
        <ChatShell.Viewport>
          <ChatShell.Content role="log" aria-label={t('thread.label')} className="pt-4">
            <ChatShell.Transcript>
              {messages.map(message => (
                <ThreadEntry key={message.id} message={message} files={files} />
              ))}
              {request.analysing ? (
                <Message from="assistant" pending>
                  <Txt as="p" variant="body-sm" tone="muted" role="status">
                    <Shimmer>{t('thread.analysing')}</Shimmer>
                  </Txt>
                </Message>
              ) : null}
              {request.lastError ? <Notice variant="destructive">{t('thread.failed', { message: request.lastError })}</Notice> : null}
            </ChatShell.Transcript>
          </ChatShell.Content>
          <ChatShell.Dock>
            <ChatShell.ScrollButton />
            <ChatShell.Column>
              <ReplyComposer request={request} />
            </ChatShell.Column>
          </ChatShell.Dock>
        </ChatShell.Viewport>
      </ChatShell.Stage>
    </ChatShell>
  );
}
