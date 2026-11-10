import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { deleteAttachment, listAttachments, uploadAttachment } from '../ui/domains/factory/services/attachments';
import type { Attachment, AttachmentSource, AttachmentTarget } from '../ui/domains/factory/services/attachments';

/** The cache key of a target's list: the card id, or `session:<id>`. */
export function attachmentOwnerKey(target: AttachmentTarget | undefined): string | undefined {
  if (!target) return undefined;
  return 'workItemId' in target ? target.workItemId : `session:${target.sessionId}`;
}

export function useAttachments(target: AttachmentTarget | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.attachments(attachmentOwnerKey(target)),
    queryFn: target ? ({ signal }) => listAttachments(baseUrl, target, signal) : skipToken,
  });
}

export interface UploadAttachmentInput {
  target: AttachmentTarget;
  file: Blob | Uint8Array;
  name: string;
  source: AttachmentSource;
  /** The media type, when `file` is bare bytes. */
  type?: string;
}

/** Uploads one file; the target's list picks it up. */
export function useUploadAttachment() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ target, file, name, source, type }: UploadAttachmentInput) =>
      uploadAttachment(baseUrl, target, file, { name, source, ...(type ? { type } : {}) }),
    onSuccess: (attachment: Attachment, { target }) => {
      queryClient.setQueryData<Attachment[]>(queryKeys.attachments(attachmentOwnerKey(target)), current =>
        current ? [...current.filter(existing => existing.id !== attachment.id), attachment] : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.attachments(attachmentOwnerKey(target)) });
    },
  });
}

export function useDeleteAttachment(target: AttachmentTarget | undefined) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const key = queryKeys.attachments(attachmentOwnerKey(target));
  return useMutation({
    mutationFn: (id: string) => deleteAttachment(baseUrl, id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<Attachment[]>(key, current => current?.filter(attachment => attachment.id !== id));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
