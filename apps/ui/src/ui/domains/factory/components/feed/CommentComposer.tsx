import { Button } from '@mastra/playground-ui/components/Button';
import { CommentQuote } from '@mastra/playground-ui/components/Comment';
import {
  Composer,
  ComposerActions,
  ComposerBox,
  ComposerInput,
  ComposerSuggestions,
} from '@mastra/playground-ui/components/Composer';
import { cn } from '@mastra/playground-ui/utils/cn';
import { ArrowUp, Paperclip, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUploadAttachment } from '../../../../../hooks/useAttachments';
import { useFactoryMembers } from '../../../../../hooks/useFactoryMembers';
import { useCan } from '../../../../../hooks/useCan';
import { useCreateWorkItemCommentMutation } from '../../../../../hooks/useWorkItemComments';
import { attachmentMessageLines, formatAttachmentSize } from '../../services/attachments';
import { mentionLabel } from './mentions';
import type { CommentQuoteDraft } from './quoteDraft';
import { useMentionResolver } from './useMentionResolver';
import { useMentionAutocomplete } from './useMentionAutocomplete';
import { Txt } from '@mastra/playground-ui/components/Txt';

type CommentComposerProps = {
  workItemId: string;
  factoryProjectId: string | undefined;
  variant: 'panel' | 'thread';
  quote?: CommentQuoteDraft;
  onDismissQuote: () => void;
};

/** The comment box, for those who may write comments (`comment.write`; a viewer only reads them). */
export function CommentComposer(props: CommentComposerProps) {
  const canComment = useCan('comment.write');
  if (!canComment) return null;
  return <CommentComposerForm {...props} />;
}

function CommentComposerForm({
  workItemId,
  factoryProjectId,
  variant,
  quote,
  onDismissQuote,
}: {
  workItemId: string;
  factoryProjectId: string | undefined;
  variant: 'panel' | 'thread';
  quote?: CommentQuoteDraft;
  onDismissQuote: () => void;
}) {
  const { t } = useTranslation('activity');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSend = useRef<{ body: string; clientToken: string } | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [sendError, setSendError] = useState<string>();
  // Files wait here until the comment is sent; they then become the card's attachments.
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAttachment = useUploadAttachment();
  const createComment = useCreateWorkItemCommentMutation({ workItemId, factoryProjectId });
  const members = useFactoryMembers(factoryProjectId, { enabled: focused });
  const resolveMentions = useMentionResolver(factoryProjectId);
  const mentions = useMentionAutocomplete({ draft, setDraft, members: members.data ?? [], textareaRef });
  const suggestionsId = useId();
  const suggestionItems = mentions.suggestions.map(member => ({
    id: `${suggestionsId}-${encodeURIComponent(member.id)}`,
    label: mentionLabel(member),
  }));

  const sendComment = async () => {
    const text = draft.trim();
    if ((text.length === 0 && files.length === 0) || createComment.isPending || uploadAttachment.isPending) return;
    setSendError(undefined);
    const sentFiles = files;
    let body = text;
    if (sentFiles.length > 0) {
      try {
        const uploaded = [];
        for (const file of sentFiles) {
          uploaded.push(
            await uploadAttachment.mutateAsync({ target: { workItemId }, file, name: file.name, source: 'comment' }),
          );
        }
        body = [text, attachmentMessageLines(uploaded)].filter(Boolean).join('\n\n');
        setFiles([]);
      } catch (cause) {
        setSendError(cause instanceof Error ? cause.message : t('comments.attachFailed'));
        return;
      }
    }
    if (pendingSend.current?.body !== body) pendingSend.current = { body, clientToken: crypto.randomUUID() };
    const { clientToken } = pendingSend.current;
    setDraft('');
    createComment.mutate(
      {
        body,
        clientToken,
        ...(quote ? { replyTo: { commentId: quote.commentId, quote: quote.quote } } : {}),
        mentions: (await resolveMentions(body)) ?? [],
      },
      {
        onSuccess: () => {
          pendingSend.current = undefined;
          onDismissQuote();
        },
        onError: cause => {
          setSendError(cause instanceof Error ? cause.message : t('comments.postError'));
          setDraft(current => (current.length === 0 ? body : current));
        },
      },
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mentions.handleKeyDown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendComment();
    }
  };

  return (
    <Composer
      onSubmit={event => {
        event.preventDefault();
        void sendComment();
      }}
      aria-label={t('comments.add')}
    >
      <ComposerBox
        data-composing={variant === 'panel' && focused ? 'true' : undefined}
        className={variant === 'thread' ? 'rounded-none border-x-0 border-b-0' : 'rounded-xl'}
      >
        <ComposerSuggestions
          id={suggestionsId}
          items={suggestionItems}
          activeIndex={mentions.activeIndex}
          contextLabel={t('comments.mentions')}
          onSelect={mentions.pickSuggestion}
        />
        {quote ? (
          <CommentQuote
            authorName={quote.authorName}
            quote={quote.quote}
            onDismiss={onDismissQuote}
            className="mx-3 mt-2"
          />
        ) : null}
        <ComposerInput
          ref={textareaRef}
          value={draft}
          placeholder={t('comments.placeholder')}
          aria-label={t('comments.input')}
          aria-autocomplete="list"
          aria-controls={suggestionItems.length > 0 ? suggestionsId : undefined}
          aria-activedescendant={suggestionItems[mentions.activeIndex]?.id}
          autoFocus={variant === 'thread'}
          maxHeight={variant === 'panel' ? '4.5rem' : '10rem'}
          className={cn(variant === 'panel' && 'min-h-9 pt-2', 'text-caption')}
          onChange={event => {
            setDraft(event.target.value);
            mentions.onDraftChange(event.target.selectionStart);
          }}
          onSelect={mentions.syncCaret}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {files.length > 0 ? (
          <ul aria-label={t('comments.attachments')} className="m-0 flex list-none flex-wrap gap-1 px-3 pt-1">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="bg-fill flex items-center gap-1 rounded-md pl-2">
                <Txt as="span" variant="meta" tone="ink" className="max-w-40 truncate">
                  {file.name}
                </Txt>
                <Txt as="span" variant="caption" tone="muted">
                  {formatAttachmentSize(file.size)}
                </Txt>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('comments.removeAttachment', { name: file.name })}
                  onClick={() => setFiles(current => current.filter((_, at) => at !== index))}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {sendError ? (
          <Txt variant="meta" role="alert" className="text-destructive-foreground m-0 px-3 pb-1">
            {sendError}
          </Txt>
        ) : null}
        <ComposerActions className="justify-end gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            aria-label={t('comments.attach')}
            onChange={event => {
              const picked = Array.from(event.target.files ?? []);
              event.target.value = '';
              setFiles(current => [...current, ...picked]);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('comments.attach')}
            tooltip={t('comments.attach')}
            disabled={uploadAttachment.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip aria-hidden />
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="icon-sm"
            aria-label={t('comments.send')}
            disabled={
              (draft.trim().length === 0 && files.length === 0) || createComment.isPending || uploadAttachment.isPending
            }
          >
            <ArrowUp aria-hidden />
          </Button>
        </ComposerActions>
      </ComposerBox>
    </Composer>
  );
}
