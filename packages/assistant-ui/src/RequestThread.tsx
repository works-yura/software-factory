import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import { Composer, ComposerActions, ComposerBox, ComposerInput } from '@mastra/playground-ui/components/Composer';
import { Input } from '@mastra/playground-ui/components/Input';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { Message } from '@mastra/playground-ui/components/Message';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowUp, ExternalLink, FileText, Paperclip, RefreshCw } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { assistantUrl, useAssistantApi, useAssistantFactories, useAssistantRequest, usePostMessage, useRequestAction } from './api';
import type { AssistantFile, AssistantMessage, AssistantRequest, RequestStatus } from './api';
import { FileChips, pastedFiles } from './NewRequestForm';

export const STATUS_BADGE: Record<RequestStatus, BadgeVariant> = {
  new: 'info',
  waiting_factory: 'purple',
  waiting_me: 'warning',
  answered: 'success',
  closed: 'neutral',
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  const { t } = useTranslation('assistant');
  return (
    <Badge size="sm" variant={STATUS_BADGE[status]}>
      {t(`status.${status}`)}
    </Badge>
  );
}

/** The topic line: what, from whom, the original, and the Factory and card once they are linked. */
function TopicLine({ request }: { request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const factory = request.factory;
  return (
    <div className="border-border flex flex-col gap-1 border-b px-4 py-3" data-testid="assistant-topic-line">
      <div className="flex min-w-0 items-center gap-2">
        <Txt as="h3" variant="heading" className="min-w-0 flex-1 truncate" title={request.topic}>
          {request.topic}
        </Txt>
        <StatusBadge status={request.status} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {request.fromName ? (
          <Txt as="span" variant="caption" tone="muted">
            {t('thread.from', { name: request.fromName })}
          </Txt>
        ) : null}
        {request.sourceUrl ? (
          <a className="text-caption text-muted-foreground inline-flex items-center gap-1 underline" href={request.sourceUrl} target="_blank" rel="noreferrer">
            {t('thread.original')}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
        {factory?.url ? (
          <a className="text-caption text-muted-foreground inline-flex items-center gap-1 underline" href={factory.url}>
            {factory.workItemId ? t('thread.factoryCard', { factory: factory.factoryName }) : t('thread.factorySession', { factory: factory.factoryName })}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function FileList({ files }: { files: AssistantFile[] }) {
  const api = useAssistantApi();
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map(file => (
        <li key={file.id}>
          <a href={assistantUrl(api, file.contentUrl)} target="_blank" rel="noreferrer" className="bg-surface3 flex max-w-60 items-center gap-2 rounded-lg p-1.5">
            {file.mime.startsWith('image/') ? (
              <img src={assistantUrl(api, file.contentUrl)} alt={file.name} className="size-12 rounded object-cover" />
            ) : (
              <FileText className="size-5 shrink-0" aria-hidden="true" />
            )}
            <Txt as="span" variant="caption" className="truncate">
              {file.name}
            </Txt>
          </a>
        </li>
      ))}
    </ul>
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
    <div className="flex flex-col items-center gap-1 py-1 text-center">
      <Txt as="p" variant="caption" tone="muted">
        {kind === 'asked' ? t('thread.askedEvent', { factory }) : t('thread.handedEvent', { factory })}
      </Txt>
      {failedAt >= 0 ? (
        <Notice variant="warning">
          {t('thread.filesFailed')} {rest.slice(failedAt + 1).join('; ')}
        </Notice>
      ) : null}
    </div>
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
      attachments={own.length ? <FileList files={own} /> : undefined}
    >
      {message.author === 'factory' ? (
        <Txt as="p" variant="caption" tone="muted">
          {label}
        </Txt>
      ) : null}
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
    <form className="flex flex-col gap-3" onSubmit={submit} aria-label={kind === 'ask' ? t('actions.ask') : t('actions.handOver')}>
      {factories.isError ? <Notice variant="destructive">{factories.error.message}</Notice> : null}
      {factories.data && !factories.data.connected ? <Notice variant="info">{t('actions.connectFirst')}</Notice> : null}
      {factories.data?.connected && reachable.length === 0 ? <Notice variant="info">{t('actions.noFactories')}</Notice> : null}
      {reachable.length > 0 ? (
        <>
          <label htmlFor={ids.factory} className="flex flex-col gap-1">
            <Txt as="span" variant="label">
              {t('actions.factory')}
            </Txt>
            <select
              id={ids.factory}
              className="border-border bg-surface2 text-body-sm h-9 rounded-md border px-2"
              value={chosen}
              onChange={event => setFactoryId(event.target.value)}
            >
              {reachable.map(factory => (
                <option key={factory.id} value={factory.id}>
                  {factory.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.text} className="flex flex-col gap-1">
            <Txt as="span" variant="label">
              {kind === 'ask' ? t('actions.question') : t('actions.title')}
            </Txt>
            {kind === 'ask' ? (
              <Textarea id={ids.text} rows={4} value={text} placeholder={t('actions.questionPlaceholder')} onChange={event => setText(event.target.value)} />
            ) : (
              <Input id={ids.text} value={text} placeholder={request.topic} onChange={event => setText(event.target.value)} />
            )}
          </label>
        </>
      ) : null}
      {mutation.isError ? <Notice variant="destructive">{mutation.error.message}</Notice> : null}
      <div className="flex justify-end gap-2">
        <AlertDialog.Cancel>{t('actions.cancel')}</AlertDialog.Cancel>
        <Button type="submit" variant="primary" disabled={!chosen || mutation.isPending}>
          {kind === 'ask' ? t('actions.confirmAsk') : t('actions.confirmHandOver')}
        </Button>
      </div>
    </form>
  );
}

function FactoryAction({ kind, request, hint }: { kind: 'ask' | 'handOver'; request: AssistantRequest; hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const [open, setOpen] = useState(false);
  const label = kind === 'ask' ? t('actions.ask') : t('actions.handOver');
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger render={<Button size="sm" variant="default">{label}</Button>} />
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{label}</AlertDialog.Title>
          <AlertDialog.Description>{request.topic}</AlertDialog.Description>
        </AlertDialog.Header>
        {open ? <FactoryDialog kind={kind} request={request} hint={hint} onDone={() => setOpen(false)} /> : null}
      </AlertDialog.Content>
    </AlertDialog>
  );
}

function ThreadActions({ request, hint }: { request: AssistantRequest; hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const actions = useRequestAction(request.id);
  if (request.status === 'closed') return null;
  const waitingOnQuestion = request.status === 'waiting_factory' && Boolean(request.factory?.sessionId);
  return (
    <div className="border-border flex flex-col gap-2 border-b px-4 py-2" role="toolbar" aria-label={t('actions.label')}>
      <div className="flex flex-wrap items-center gap-2">
        <FactoryAction kind="ask" request={request} hint={hint} />
        {!request.factory?.workItemId ? <FactoryAction kind="handOver" request={request} hint={hint} /> : null}
        {waitingOnQuestion ? (
          <Button size="sm" variant="ghost" disabled={actions.checkAnswer.isPending} onClick={() => actions.checkAnswer.mutate()}>
            <RefreshCw aria-hidden="true" />
            {t('actions.checkAnswer')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={actions.close.isPending} onClick={() => actions.close.mutate()}>
          {t('actions.close')}
        </Button>
      </div>
      {hint && !request.factory ? (
        <Txt as="p" variant="caption" tone="muted">
          {t('actions.hint', { factory: hint.name })}
        </Txt>
      ) : null}
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
    </div>
  );
}

function ReplyComposer({ request }: { request: AssistantRequest }) {
  const { t } = useTranslation('assistant');
  const post = usePostMessage(request.id);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  if (request.status === 'closed') {
    return (
      <Txt as="p" variant="caption" tone="muted" className="py-2 text-center">
        {t('thread.closedNotice')}
      </Txt>
    );
  }
  const canSend = (text.trim().length > 0 || files.length > 0) && !post.isPending && !request.analysing;
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
  return (
    <Composer onSubmit={submit} aria-label={t('thread.reply')}>
      {post.isError ? <Notice variant="destructive">{post.error.message}</Notice> : null}
      <ComposerBox>
        <ComposerInput
          aria-label={t('thread.reply')}
          placeholder={t('thread.reply')}
          value={text}
          onChange={event => setText(event.target.value)}
          onPaste={event => {
            const pasted = pastedFiles(event);
            if (pasted.length === 0) return;
            event.preventDefault();
            setFiles(current => [...current, ...pasted]);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <ComposerActions>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <FileChips files={files} onRemove={index => setFiles(current => current.filter((_, at) => at !== index))} />
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={event => {
                const chosen = Array.from(event.target.files ?? []);
                setFiles(current => [...current, ...chosen]);
                event.target.value = '';
              }}
            />
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t('thread.attach')} onClick={() => picker.current?.click()}>
              <Paperclip aria-hidden="true" />
            </Button>
          </div>
          <Button type="submit" size="icon-sm" variant="primary" aria-label={t('thread.send')} disabled={!canSend}>
            <ArrowUp aria-hidden="true" />
          </Button>
        </ComposerActions>
      </ComposerBox>
    </Composer>
  );
}

/** An open request: its topic line, actions, the thread, and the person's composer. */
export function RequestThread({ requestId, hint }: { requestId: string; hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const view = useAssistantRequest(requestId);
  if (view.isError) return <Notice variant="destructive">{view.error.message}</Notice>;
  if (!view.data) {
    return (
      <Txt as="p" variant="caption" tone="muted" className="p-4">
        {t('panel.loading')}
      </Txt>
    );
  }
  const { request, messages, files } = view.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-thread">
      <TopicLine request={request} />
      <ThreadActions request={request} hint={hint} />
      <ChatShell className="min-h-0 flex-1" scroller={{ autoScroll: true, defaultScrollPosition: 'end' }}>
        <ChatShell.Stage>
          <ChatShell.Viewport>
            <ChatShell.Content role="log" aria-label={t('thread.label')} className="gap-3 px-4 pt-4">
              {messages.map(message => (
                <ThreadEntry key={message.id} message={message} files={files} />
              ))}
              {request.analysing ? (
                <Message from="assistant" pending>
                  <Txt as="p" variant="caption" tone="muted" role="status">
                    {t('thread.analysing')}
                  </Txt>
                </Message>
              ) : null}
              {request.lastError ? <Notice variant="destructive">{t('thread.failed', { message: request.lastError })}</Notice> : null}
            </ChatShell.Content>
            <ChatShell.Dock>
              <ChatShell.Column className="gap-2 px-2 pb-2">
                <ReplyComposer request={request} />
              </ChatShell.Column>
            </ChatShell.Dock>
          </ChatShell.Viewport>
        </ChatShell.Stage>
      </ChatShell>
    </div>
  );
}
