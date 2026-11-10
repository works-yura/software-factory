import { ComposerAttachment } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment';
import { ComposerAttachmentEntry } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-entry';
import { ComposerAttachmentList } from '@mastra/playground-ui/domains/chat/attachments/composer-attachment-list';
import { File, FileText, Image } from 'lucide-react';

import type { PendingFile } from './useComposerImages';

function FileIcon({ type }: { type: string }) {
  if (type.startsWith('image/')) return <Image size={16} aria-hidden />;
  if (type === 'application/pdf' || type.startsWith('text/')) return <FileText size={16} aria-hidden />;
  return <File size={16} aria-hidden />;
}

/** Files waiting in the composer; on send they become the card's attachments, named in the message. */
export function ComposerFileAttachments({ files, onRemove }: { files: PendingFile[]; onRemove: (id: string) => void }) {
  if (files.length === 0) return null;
  return (
    <ComposerAttachmentList>
      {files.map(pending => (
        <ComposerAttachment
          key={pending.id}
          name={pending.file.name}
          variant="inline"
          onRemove={() => onRemove(pending.id)}
        >
          <ComposerAttachmentEntry>
            <FileIcon type={pending.file.type} />
          </ComposerAttachmentEntry>
        </ComposerAttachment>
      ))}
    </ComposerAttachmentList>
  );
}
