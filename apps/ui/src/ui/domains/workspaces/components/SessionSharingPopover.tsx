import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState, EmptyStateIllustration } from '@mastra/playground-ui/components/EmptyState';
import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Icon } from '@mastra/playground-ui/icons/Icon';
import { Lock, Users } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

/** Private-session entry point shared by the sidebar and session header. */
export function SessionSharingPopover({
  name,
  placement = 'sidebar',
  disabled,
  onShare,
  sharing,
}: {
  name: string;
  placement?: 'sidebar' | 'header';
  disabled?: boolean;
  onShare?: () => void;
  sharing?: boolean;
}) {
  const { t } = useTranslation('workspaces');
  const titleId = useId();
  const inHeader = placement === 'header';

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={inHeader ? 'sm' : 'icon-sm'}
            aria-label={inHeader ? t('sharing.privateSession') : t('sharing.privateSessionNamed', { name })}
            disabled={disabled}
          >
            {inHeader ? (
              <Lock />
            ) : (
              <Icon size="xs">
                <Lock />
              </Icon>
            )}
            {inHeader ? t('sharing.private') : null}
          </Button>
        }
      />
      <PopoverContent align="end" aria-labelledby={titleId}>
        <EmptyState
          iconSlot={<EmptyStateIllustration name="locked" />}
          titleSlot={<span id={titleId}>{t('sharing.privateTitle')}</span>}
          descriptionSlot={onShare ? t('sharing.privateDescriptionShareable') : t('sharing.privateDescription')}
          actionSlot={
            onShare ? (
              <Button onClick={onShare} disabled={disabled || sharing} aria-busy={sharing}>
                {sharing ? <Spinner size="sm" aria-hidden /> : <Users />}
                {t('sharing.shareWithOrg')}
              </Button>
            ) : undefined
          }
        />
      </PopoverContent>
    </Popover>
  );
}
