import { Button } from '@mastra/playground-ui/components/Button';
import { FileDropZone } from '@mastra/playground-ui/components/FileDropZone';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Paperclip, X } from 'lucide-react';
import { useId, useState } from 'react';
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

export function FileChips({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useTranslation('assistant');
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t('newRequest.files')}>
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="bg-surface3 flex items-center gap-1 rounded-full py-0.5 pr-0.5 pl-2">
          <Paperclip className="size-3" aria-hidden="true" />
          <Txt as="span" variant="caption" className="max-w-48 truncate">
            {file.name}
          </Txt>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('newRequest.removeFile', { name: file.name })}
            onClick={() => onRemove(index)}
          >
            <X aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
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
    <form className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" aria-label={t('newRequest.title')} onSubmit={submit}>
      <Txt as="h3" variant="heading" className="font-medium">
        {t('newRequest.title')}
      </Txt>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.text}>
          <Txt as="span" variant="label">
            {t('newRequest.text')}
          </Txt>
        </label>
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
      </div>
      <FileDropZone
        title={t('newRequest.dropTitle')}
        description={t('newRequest.dropDescription')}
        buttonLabel={t('newRequest.dropButton')}
        multiple
        onFiles={dropped => setFiles(current => [...current, ...dropped])}
      />
      <FileChips files={files} onRemove={index => setFiles(current => current.filter((_, at) => at !== index))} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.from}>
            <Txt as="span" variant="label">
              {t('newRequest.from')}
            </Txt>
          </label>
          <Input id={ids.from} value={fromName} placeholder={t('newRequest.fromPlaceholder')} onChange={event => setFromName(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.source}>
            <Txt as="span" variant="label">
              {t('newRequest.source')}
            </Txt>
          </label>
          <Input
            id={ids.source}
            type="url"
            value={sourceUrl}
            placeholder={t('newRequest.sourcePlaceholder')}
            onChange={event => setSourceUrl(event.target.value)}
          />
        </div>
      </div>
      {create.isError ? <Notice variant="destructive">{create.error.message}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('newRequest.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={!canSend}>
          {create.isPending ? t('newRequest.sending') : t('newRequest.submit')}
        </Button>
      </div>
    </form>
  );
}
