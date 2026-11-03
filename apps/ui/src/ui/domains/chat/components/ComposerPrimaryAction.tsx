import { Button } from '@mastra/playground-ui/components/Button';
import { ArrowUp, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ComposerPrimaryActionProps {
  showAbort: boolean;
  sendDisabled: boolean;
  sendTitle?: string;
  onAbort: () => void;
}

export function ComposerPrimaryAction({ showAbort, sendDisabled, sendTitle, onAbort }: ComposerPrimaryActionProps) {
  const { t } = useTranslation('chat');
  if (showAbort) {
    return (
      <Button
        type="button"
        size="icon-sm"
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
    <Button type="submit" size="icon-sm" disabled={sendDisabled} aria-label={t('composer.send')} title={sendTitle}>
      <ArrowUp size={16} />
    </Button>
  );
}
