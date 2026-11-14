import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../../api/config';
import { AVATAR_ACCEPT, avatarDataUrl, avatarSrc, uploadAvatar } from '../../../auth/services/team';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An avatar with "Add/Change avatar" and "Remove": the picked image is cropped and scaled to 256 px
 * in the browser, uploaded (`/auth/api/factory/avatars`), and its URL handed to `onChange`; Remove
 * hands `null`. Without `editable` it only shows the avatar.
 */
export function AvatarPicker({
  name,
  src,
  editable,
  onChange,
}: {
  name: string;
  src?: string | null;
  editable: boolean;
  onChange: (url: string | null) => Promise<unknown>;
}) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return onChange(null);
      let dataUrl: string;
      try {
        dataUrl = await avatarDataUrl(file);
      } catch {
        throw new Error(t('avatar.unsupported'));
      }
      const { url } = await uploadAvatar(baseUrl, dataUrl);
      return onChange(url);
    },
  });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {editable ? (
          <>
            <input
              ref={input}
              type="file"
              accept={AVATAR_ACCEPT}
              className="hidden"
              aria-label={src ? t('avatar.change') : t('avatar.add')}
              data-testid="avatar-file"
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) save.mutate(file);
              }}
            />
            <Button size="sm" disabled={save.isPending} onClick={() => input.current?.click()}>
              {save.isPending ? t('avatar.uploading') : src ? t('avatar.change') : t('avatar.add')}
            </Button>
            {src ? (
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
                {t('avatar.remove')}
              </Button>
            ) : null}
          </>
        ) : null}
        <Avatar name={name} src={avatarSrc(baseUrl, src)} size="md" />
      </div>
      {save.isError ? (
        <Notice variant="destructive" role="alert">
          {t('avatar.failed', { message: errorText(save.error) })}
        </Notice>
      ) : null}
    </div>
  );
}
