import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { FileDropZone } from '@mastra/playground-ui/components/FileDropZone';
import { Header } from '@mastra/playground-ui/components/Header';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ImageEntry } from '@mastra/playground-ui/domains/chat/attachments/attachment-preview-dialog';
import { ComposerAttachment } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment';
import { ComposerAttachmentEntry } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-entry';
import { ComposerAttachmentList } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-list';
import { attachmentInfo } from '@mastra/playground-ui/domains/chat/attachments/message-attachment-info';
import { useEffect, useId, useState } from 'react';
import type { ClipboardEvent, FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useCreateRequest } from './api';
import type { AssistantRequest } from './api';

/** Files pasted from the clipboard (screenshots) come unnamed; give them a name the thread can show. */
export function pastedFiles(event: ClipboardEvent): File[] {
  const items = Array.from(event.clipboardData?.items ?? []);
  return items.flatMap((item, index) => {
    if (item.kind !== 'file') return [];
    const file = item.getAsFile();
    if (!file) return [];
    if (file.name && file.name !== 'image.png') return [file];
    const extension = file.type.split('/')[1] ?? 'png';
    return [new File([file], `screenshot-${Date.now()}-${index}.${extension}`, { type: file.type })];
  });
}

/** A local preview of a picked image, released when the file leaves the draft. */
function useObjectUrl(file: File): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return;
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);
  return url;
}

function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const { t } = useTranslation('assistant');
  const preview = useObjectUrl(file);
  const { Icon, label } = attachmentInfo(file.name, file.type);
  return (
    <ComposerAttachment
      name={file.name}
      variant={preview ? 'thumbnail' : 'inline'}
      removeLabel={t('newRequest.removeFile', { name: file.name })}
      onRemove={onRemove}
    >
      {preview ? (
        <ImageEntry src={preview} name={file.name} />
      ) : (
        <ComposerAttachmentEntry description={label}>
          <Icon size={16} aria-hidden />
        </ComposerAttachmentEntry>
      )}
    </ComposerAttachment>
  );
}

/** The files a draft carries: the app composer's attachment cards, removable before sending. */
export function PendingFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useTranslation('assistant');
  if (files.length === 0) return null;
  return (
    <ComposerAttachmentList aria-label={t('newRequest.files')}>
      {files.map((file, index) => (
        <PendingFile key={`${file.name}-${file.lastModified}-${index}`} file={file} onRemove={() => onRemove(index)} />
      ))}
    </ComposerAttachmentList>
  );
}

/**
 * A request the person brings themself: paste what a colleague wrote (text, a screenshot with
 * Ctrl+V), drop files, say who it is from and link the original.
 */
export function NewRequestForm({ onCreated, onCancel }: { onCreated: (request: AssistantRequest) => void; onCancel: () => void }) {
  const { t } = useTranslation('assistant');
  const create = useCreateRequest();
  const [text, setText] = useState('');
  const [fromName, setFromName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const ids = { text: useId(), from: useId(), source: useId() };
  const canSend = (text.trim().length > 0 || files.length > 0) && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    create.mutate(
      { text, fromName: fromName.trim() || undefined, sourceUrl: sourceUrl.trim() || undefined, files },
      { onSuccess: request => onCreated(request) },
    );
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" aria-label={t('newRequest.title')} onSubmit={submit}>
      <Header>
        <Txt as="h3" variant="heading">
          {t('newRequest.title')}
        </Txt>
      </Header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Field>
          <FieldLabel htmlFor={ids.text}>{t('newRequest.text')}</FieldLabel>
          <Textarea
            id={ids.text}
            value={text}
            rows={6}
            placeholder={t('newRequest.textPlaceholder')}
            onChange={event => setText(event.target.value)}
            onPaste={event => {
              const pasted = pastedFiles(event);
              if (pasted.length === 0) return;
              event.preventDefault();
              setFiles(current => [...current, ...pasted]);
            }}
          />
        </Field>
        <FileDropZone
          title={t('newRequest.dropTitle')}
          description={t('newRequest.dropDescription')}
          buttonLabel={t('newRequest.dropButton')}
          multiple
          onFiles={dropped => setFiles(current => [...current, ...dropped])}
        />
        <PendingFiles files={files} onRemove={index => setFiles(current => current.filter((_, at) => at !== index))} />
        <Field>
          <FieldLabel htmlFor={ids.from}>{t('newRequest.from')}</FieldLabel>
          <Input id={ids.from} value={fromName} placeholder={t('newRequest.fromPlaceholder')} onChange={event => setFromName(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor={ids.source}>{t('newRequest.source')}</FieldLabel>
          <Input
            id={ids.source}
            type="url"
            value={sourceUrl}
            placeholder={t('newRequest.sourcePlaceholder')}
            onChange={event => setSourceUrl(event.target.value)}
          />
        </Field>
        {create.isError ? <Notice variant="destructive">{create.error.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('newRequest.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSend}>
            {create.isPending ? t('newRequest.sending') : t('newRequest.submit')}
          </Button>
        </div>
      </div>
    </form>
  );
}
