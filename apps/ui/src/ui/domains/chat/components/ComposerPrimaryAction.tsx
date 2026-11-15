import { Button } from '@mastra/playground-ui/components/Button';
import { ArrowUp, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { TOUCH_TARGET } from './ComposerSendButtons';

interface ComposerPrimaryActionProps {
  showAbort: boolean;
  sendDisabled: boolean;
  sendTitle?: string;
  /** A finger's pointer: the 32px button with a 40px hit area (see `ComposerSendButtons`). */
  touch?: boolean;
  onAbort: () => void;
}

export function ComposerPrimaryAction({ showAbort, sendDisabled, sendTitle, touch = false, onAbort }: ComposerPrimaryActionProps) {
  const { t } = useTranslation('chat');
  const size = touch ? 'icon-lg' : 'icon-sm';
  const className = touch ? TOUCH_TARGET : undefined;
  if (showAbort) {
    return (
      <Button
        type="button"
        size={size}
        className={className}
        onClick={event => {
          // Send turns into Abort under the pointer: a double-click on Send must not abort.
          if (event.detail > 1) return;
          onAbort();
        }}
        aria-label={t('composer.abort')}
      >
        <Square size={14} />
      </Button>
    );
  }

  return (
    <Button
      type="submit"
      size={size}
      className={className}
      disabled={sendDisabled}
      aria-label={t('composer.send')}
      title={sendTitle}
    >
      <ArrowUp size={16} />
    </Button>
  );
}
