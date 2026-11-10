import { useParams } from 'react-router';

import { useUploadAttachment } from '../../../../hooks/useAttachments';
import { useWorkItemsQuery } from '../../../../hooks/useWorkItems';
import { attachmentMessageLines, base64ToBytes } from '../../factory/services/attachments';
import type { Attachment, AttachmentTarget } from '../../factory/services/attachments';
import type { PendingImage } from '../context/ComposerImagesContext';
import type { PendingFile } from '../components/useComposerImages';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

/**
 * Where a chat's files go: the card the session works, or the session itself when it works none
 * (its own files, listed by `factory_list_attachments` the same way).
 */
export function useComposerAttachmentTarget(sessionId: string | undefined): AttachmentTarget | undefined {
  const { factoryId } = useParams<{ factoryId?: string }>();
  const workItems = useWorkItemsQuery(factoryId);
  if (!sessionId) return undefined;
  const card = workItems.data?.find(item => Object.values(item.sessions).some(session => session.sessionId === sessionId));
  return card ? { workItemId: card.id } : { sessionId };
}

/** Message text followed by its «Вкладення:» lines. */
export function withAttachmentLines(message: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return message;
  return [message.trim(), attachmentMessageLines(attachments)].filter(Boolean).join('\n\n');
}

/**
 * Stores what a message carries as attachments before it is sent: images (also shown to the model)
 * and the other files. A failed upload throws, so the send fails and the composer keeps them.
 */
export function useComposerAttachmentUpload(sessionId: string | undefined) {
  const target = useComposerAttachmentTarget(sessionId);
  const upload = useUploadAttachment();

  return async (images: readonly PendingImage[], files: readonly PendingFile[]): Promise<Attachment[]> => {
    if (images.length === 0 && files.length === 0) return [];
    if (!target) throw new Error(tk('composer.noAttachmentTarget'));
    const uploaded: Attachment[] = [];
    for (const image of images) {
      uploaded.push(
        await upload.mutateAsync({
          target,
          file: base64ToBytes(image.data),
          type: image.mediaType,
          name: image.filename ?? `image.${image.mediaType.split('/')[1] ?? 'png'}`,
          source: 'chat',
        }),
      );
    }
    for (const pending of files) {
      uploaded.push(await upload.mutateAsync({ target, file: pending.file, name: pending.file.name, source: 'chat' }));
    }
    return uploaded;
  };
}
