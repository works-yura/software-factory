import { Button } from '@mastra/playground-ui/components/Button';
import { ComposerInput } from '@mastra/playground-ui/components/Composer';
import type { ComposerInputProps } from '@mastra/playground-ui/components/Composer';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { ImageEntry } from '@mastra/playground-ui/domains/chat/attachments/attachment-preview-dialog';
import { ComposerAttachment } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment';
import { ComposerAttachmentEntry } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-entry';
import { ComposerAttachmentList } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-list';
import { attachmentInfo } from '@mastra/playground-ui/domains/chat/attachments/message-attachment-info';
import { ArrowUp, Paperclip } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The pieces a request thread's reply and a new request share: the input (paste a screenshot,
 * Enter sends, Shift+Enter breaks the line), the attachment cards, the paperclip and the arrow.
 */

/** A shortcut hint for a tooltip: the action's name and its key. */
export function ShortcutHint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-2">
      {label}
      <span className="flex gap-0.5">
        {keys.map(key => (
          <Kbd key={key} size="xs">
            {key}
          </Kbd>
        ))}
      </span>
    </span>
  );
}

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

/** The files a draft carries, added by paste, drop or the picker, removable before sending. */
export function useDraftFiles() {
  const [files, setFiles] = useState<File[]>([]);
  return {
    files,
    add: (added: File[]) => setFiles(current => [...current, ...added]),
    removeAt: (index: number) => setFiles(current => current.filter((_, at) => at !== index)),
    clear: () => setFiles([]),
  };
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

export interface DraftInputProps extends ComposerInputProps {
  /** Takes pasted screenshots and files; without it a paste is only text. */
  onFiles?: (files: File[]) => void;
}

/** The composer's text: a pasted screenshot becomes an attachment, Enter sends, Shift+Enter breaks the line. */
export const DraftInput = forwardRef<HTMLTextAreaElement, DraftInputProps>(({ onFiles, onPaste, onKeyDown, ...props }, ref) => (
  <ComposerInput
    ref={ref}
    {...props}
    onPaste={event => {
      onPaste?.(event);
      if (!onFiles || event.defaultPrevented) return;
      const pasted = pastedFiles(event);
      if (pasted.length === 0) return;
      event.preventDefault();
      onFiles(pasted);
    }}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    }}
  />
));
DraftInput.displayName = 'DraftInput';

/**
 * The hidden file picker and what opens it. The input renders outside a `ButtonsGroup`, so the
 * group's seams see only its buttons.
 */
export function useFilePicker(onFiles: (files: File[]) => void) {
  const { t } = useTranslation('assistant');
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      hidden
      aria-label={t('thread.attach')}
      onChange={event => {
        onFiles(Array.from(event.target.files ?? []));
        event.target.value = '';
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}

/** The paperclip that opens the picker. */
export function AttachButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('assistant');
  return (
    <Button type="button" size="icon-sm" aria-label={t('thread.attach')} tooltip={t('thread.attach')} onClick={onClick}>
      <Paperclip />
    </Button>
  );
}

/** The round arrow that sends, Enter in its tooltip. */
export function SendButton({ disabled, label }: { disabled: boolean; label?: string }) {
  const { t } = useTranslation('assistant');
  const name = label ?? t('thread.send');
  return (
    <Button type="submit" size="icon-sm" variant="primary" aria-label={name} tooltip={<ShortcutHint label={name} keys={['↵']} />} disabled={disabled}>
      <ArrowUp />
    </Button>
  );
}
