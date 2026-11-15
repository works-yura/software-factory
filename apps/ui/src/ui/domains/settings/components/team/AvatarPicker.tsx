import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Button } from '@mastra/playground-ui/components/Button';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../../api/config';
import { AVATAR_ACCEPT, avatarSrc } from '../../../auth/services/team';
import { errorText } from '../../../../../lib/errorText';
import { useAvatarUpload } from '../../hooks/useAccount';

/**
 * An avatar with "Add/Change avatar" and "Remove": the picked image is cropped and scaled to 256 px
 * in the browser, uploaded, and its URL handed to `onChange`; Remove hands `null`. Without
 * `editable` it only shows the avatar.
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
  const save = useAvatarUpload(onChange, t('avatar.unsupported'));
  const avatar = <Avatar name={name} src={avatarSrc(baseUrl, src)} size="md" />;

  if (!editable) return avatar;
  return (
    <div className="flex min-w-0 flex-col items-start gap-2 sm:items-end">
      <div className="flex items-center gap-3">
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
        <ButtonsGroup size="sm">
          <Button size="sm" disabled={save.isPending} onClick={() => input.current?.click()}>
            {save.isPending ? t('avatar.uploading') : src ? t('avatar.change') : t('avatar.add')}
          </Button>
          {src ? (
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(null)}>
              {t('avatar.remove')}
            </Button>
          ) : null}
        </ButtonsGroup>
        {avatar}
      </div>
      {save.isError ? (
        <Notice variant="destructive" role="alert" className="self-stretch">
          {t('avatar.failed', { message: errorText(save.error) })}
        </Notice>
      ) : null}
    </div>
  );
}
