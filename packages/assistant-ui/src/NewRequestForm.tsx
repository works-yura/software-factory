import { Button } from '@mastra/playground-ui/components/Button';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import {
  Composer,
  ComposerActions,
  ComposerBox,
  ComposerHeader,
  ComposerHeaderRow,
  ComposerRing,
} from '@mastra/playground-ui/components/Composer';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { FileDropBackdrop } from '@mastra/playground-ui/components/FileDropBackdrop';
import { Header, HeaderAction } from '@mastra/playground-ui/components/Header';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Link2, MessageSquarePlus, Plus, User, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useCreateRequest } from './api';
import type { AssistantRequest } from './api';
import { AttachButton, DraftInput, PendingFiles, SendButton, ShortcutHint, useDraftFiles, useFilePicker } from './DraftComposer';

/**
 * An optional detail of the request (who it is from, the link to the original) as a quiet
 * «+ From» in the composer's header; pressed, it turns into a compact field with its own ✕.
 */
function DetailChip({
  icon,
  label,
  placeholder,
  value,
  type = 'text',
  onChange,
  onDone,
}: {
  icon: ReactNode;
  label: string;
  placeholder: string;
  value: string;
  type?: 'text' | 'url';
  onChange: (value: string) => void;
  /** Hands focus back to the message when the field closes. */
  onDone: () => void;
}) {
  const { t } = useTranslation('assistant');
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" icon={<Plus />} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  const close = () => {
    onChange('');
    setOpen(false);
    onDone();
  };
  return (
    <span className="flex min-w-48 flex-1 items-center gap-1">
      {icon}
      <Input
        size="sm"
        type={type}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          // Escape leaves the field for the message (closing it when empty), not the whole request.
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          if (!value.trim()) setOpen(false);
          onDone();
        }}
      />
      <Button type="button" size="icon-sm" variant="ghost" aria-label={t('newRequest.removeDetail', { label })} onClick={close}>
        <X />
      </Button>
    </span>
  );
}

/**
 * A request the person brings themself, laid out as a new chat: an empty thread with a line on
 * what happens next and the thread's own composer — paste what a colleague wrote (text, a
 * screenshot with Ctrl+V), drop files anywhere on the pane, add who it is from and the link to the
 * original from the composer's header, Enter sends. Escape or ✕ in the header leaves it.
 */
export function NewRequestForm({ onCreated, onCancel }: { onCreated: (request: AssistantRequest) => void; onCancel: () => void }) {
  const { t } = useTranslation('assistant');
  const create = useCreateRequest();
  const [text, setText] = useState('');
  const [fromName, setFromName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const { files, add, removeAt } = useDraftFiles();
  const picker = useFilePicker(add);
  const input = useRef<HTMLTextAreaElement>(null);
  const focusMessage = () => input.current?.focus();
  const canSend = (text.trim().length > 0 || files.length > 0) && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    create.mutate(
      { text, fromName: fromName.trim() || undefined, sourceUrl: sourceUrl.trim() || undefined, files },
      { onSuccess: request => onCreated(request) },
    );
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // The request is left, the panel stays open.
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <FileDropBackdrop onFilesDrop={add} label={t('newRequest.dropTitle')} description={t('newRequest.dropDescription')}>
      <ChatShell
        data-testid="assistant-new-request"
        className="flex-1 [--chat-surface:var(--assistant-surface,var(--color-card))]"
        onKeyDown={escape}
      >
        <Header>
          <Txt as="h3" variant="heading">
            {t('newRequest.title')}
          </Txt>
          <HeaderAction>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('newRequest.cancel')}
              aria-keyshortcuts="Escape"
              tooltip={<ShortcutHint label={t('newRequest.cancel')} keys={['Esc']} />}
              onClick={onCancel}
            >
              <X />
            </Button>
          </HeaderAction>
        </Header>
        <ChatShell.Stage>
          <ChatShell.Viewport>
            <ChatShell.Content>
              <ChatShell.Transcript className="flex-1 justify-center">
                <EmptyState iconSlot={<MessageSquarePlus />} titleSlot={t('newRequest.emptyTitle')} descriptionSlot={t('newRequest.emptyDescription')} />
              </ChatShell.Transcript>
            </ChatShell.Content>
            <ChatShell.Dock>
              <ChatShell.Column>
                <Composer onSubmit={submit} aria-label={t('newRequest.title')}>
                  <ComposerHeader>
                    <ComposerHeaderRow>
                      <DetailChip
                        icon={<User aria-hidden />}
                        label={t('newRequest.from')}
                        placeholder={t('newRequest.fromPlaceholder')}
                        value={fromName}
                        onChange={setFromName}
                        onDone={focusMessage}
                      />
                      <DetailChip
                        icon={<Link2 aria-hidden />}
                        label={t('newRequest.source')}
                        placeholder={t('newRequest.sourcePlaceholder')}
                        type="url"
                        value={sourceUrl}
                        onChange={setSourceUrl}
                        onDone={focusMessage}
                      />
                    </ComposerHeaderRow>
                    {create.isError ? <ComposerHeaderRow tone="destructive">{create.error.message}</ComposerHeaderRow> : null}
                  </ComposerHeader>
                  <ComposerRing busy={create.isPending}>
                    <ComposerBox>
                      <PendingFiles files={files} onRemove={removeAt} />
                      <DraftInput
                        ref={input}
                        autoFocus
                        aria-label={t('newRequest.text')}
                        placeholder={t('newRequest.placeholder')}
                        value={text}
                        onChange={event => setText(event.target.value)}
                        onFiles={add}
                      />
                      {picker.input}
                      <ComposerActions>
                        <ButtonsGroup size="sm" className="ml-auto" aria-label={t('composer.actions')}>
                          <AttachButton onClick={picker.open} />
                          <SendButton disabled={!canSend} label={t('newRequest.submit')} />
                        </ButtonsGroup>
                      </ComposerActions>
                    </ComposerBox>
                  </ComposerRing>
                </Composer>
              </ChatShell.Column>
            </ChatShell.Dock>
          </ChatShell.Viewport>
        </ChatShell.Stage>
      </ChatShell>
    </FileDropBackdrop>
  );
}
