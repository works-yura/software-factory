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
import { Txt } from '@mastra/playground-ui/components/Txt';
import { MessageSquarePlus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useCreateRequest } from './api';
import type { AssistantRequest } from './api';
import { AttachButton, DraftInput, PendingFiles, SendButton, ShortcutHint, useDraftFiles, useFilePicker } from './DraftComposer';

/** The first web link in what was pasted: the request's «original» without a separate field. */
export function firstLink(text: string): string | undefined {
  return /https?:\/\/[^\s<>()]+/i.exec(text)?.[0]?.replace(/[.,;:!?»"']+$/, '');
}

/**
 * A request the person brings themself, laid out as a new chat: an empty thread with a line on
 * what happens next and the thread's own composer — paste what a colleague wrote (text, a
 * screenshot with Ctrl+V), drop files anywhere on the pane, Enter sends. Who it is from and where it
 * came from are just written in the text — the assistant reads them; a pasted link becomes the
 * request's original. Escape or ✕ in the header leaves it.
 */
export function NewRequestForm({ onCreated, onCancel }: { onCreated: (request: AssistantRequest) => void; onCancel: () => void }) {
  const { t } = useTranslation('assistant');
  const create = useCreateRequest();
  const [text, setText] = useState('');
  const { files, add, removeAt } = useDraftFiles();
  const picker = useFilePicker(add);
  const input = useRef<HTMLTextAreaElement>(null);
  const canSend = (text.trim().length > 0 || files.length > 0) && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    create.mutate(
      { text, sourceUrl: firstLink(text), files },
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
                  {create.isError ? (
                    <ComposerHeader>
                      <ComposerHeaderRow tone="destructive">{create.error.message}</ComposerHeaderRow>
                    </ComposerHeader>
                  ) : null}
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
