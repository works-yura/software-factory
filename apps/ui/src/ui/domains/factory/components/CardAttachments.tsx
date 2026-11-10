import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import { Download, File, FileText, GitBranch, Image, MessageSquare, Paperclip, SquareCheck, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { useAttachments, useDeleteAttachment, useUploadAttachment } from '../../../../hooks/useAttachments';
import { attachmentContentUrl, formatAttachmentSize } from '../services/attachments';
import type { Attachment, AttachmentSource } from '../services/attachments';

function SourceIcon({ source }: { source: AttachmentSource }) {
  if (source === 'chat') return <MessageSquare size={12} aria-hidden />;
  if (source === 'comment') return <MessageSquare size={12} aria-hidden />;
  if (source === 'clickup') return <SquareCheck size={12} aria-hidden />;
  if (source === 'github' || source === 'gitlab') return <GitBranch size={12} aria-hidden />;
  return <Upload size={12} aria-hidden />;
}

function FileKindIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <Image size={14} aria-hidden />;
  if (mime === 'application/pdf' || mime.startsWith('text/')) return <FileText size={14} aria-hidden />;
  return <File size={14} aria-hidden />;
}

/** «Файли»: the files attached to a card, from chat, comments, uploads and (later) the tracker. */
export function CardAttachments({ workItemId, enabled }: { workItemId: string; enabled: boolean }) {
  const { t } = useTranslation('board');
  const { baseUrl } = useApiConfig();
  const target = enabled ? { workItemId } : undefined;
  const attachments = useAttachments(target);
  const upload = useUploadAttachment();
  const remove = useDeleteAttachment(target);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    setError(undefined);
    for (const file of files) {
      try {
        await upload.mutateAsync({ target: { workItemId }, file, name: file.name, source: 'upload' });
      } catch (cause) {
        setError(t('attachments.uploadFailed', { name: file.name, reason: cause instanceof Error ? cause.message : '' }));
        return;
      }
    }
  };

  const onDelete = (attachment: Attachment) => {
    setError(undefined);
    remove.mutate(attachment.id, {
      onError: cause =>
        setError(t('attachments.deleteFailed', { name: attachment.name, reason: cause instanceof Error ? cause.message : '' })),
    });
  };

  const list = attachments.data ?? [];

  return (
    <section aria-label={t('attachments.title')} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Txt as="h4" variant="eyebrow" tone="muted" className="m-0 flex-1">
          {t('attachments.title')}
        </Txt>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('attachments.add')}
          tooltip={t('attachments.add')}
          disabled={upload.isPending}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip size={13} aria-hidden />
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          aria-label={t('attachments.add')}
          onChange={event => void onFiles(event)}
        />
      </div>
      {attachments.isError ? (
        <Txt variant="meta" role="alert" className="text-destructive-foreground m-0">
          {attachments.error instanceof Error ? attachments.error.message : t('attachments.loadFailed')}
        </Txt>
      ) : list.length === 0 ? (
        <Txt variant="meta" tone="muted" className="m-0">
          {attachments.isPending && enabled ? t('attachments.loading') : t('attachments.empty')}
        </Txt>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {list.map(attachment => (
            <li key={attachment.id} className="flex items-center gap-1">
              <a
                href={attachmentContentUrl(baseUrl, attachment)}
                target="_blank"
                rel="noreferrer"
                className={`hover:bg-fill-hover flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-0.5 ${focusRing}`}
                title={attachment.name}
              >
                <FileKindIcon mime={attachment.mime} />
                <Txt as="span" variant="meta" tone="ink" className="min-w-0 flex-1 truncate">
                  {attachment.name}
                </Txt>
                <span className="text-muted-foreground flex items-center" title={t(`attachments.source.${attachment.source}`)}>
                  <SourceIcon source={attachment.source} />
                  <span className="sr-only">{t(`attachments.source.${attachment.source}`)}</span>
                </span>
                <Txt as="span" variant="caption" tone="muted">
                  {formatAttachmentSize(attachment.size)}
                </Txt>
              </a>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('attachments.download', { name: attachment.name })}
                render={<a href={attachmentContentUrl(baseUrl, attachment, true)} download={attachment.name} />}
              >
                <Download size={12} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('attachments.delete', { name: attachment.name })}
                disabled={remove.isPending}
                onClick={() => onDelete(attachment)}
              >
                <Trash2 size={12} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <Txt variant="meta" role="alert" className="text-destructive-foreground m-0">
          {error}
        </Txt>
      ) : null}
    </section>
  );
}
