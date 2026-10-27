import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useKeyboardShortcutLabel } from '@mastra/playground-ui/hooks/use-keyboard-shortcut-label';
import { useTranslation } from 'react-i18next';

import { useOverlays } from '../../../lib/overlays';
import { translator } from '../../../i18n/t';

const tk = translator('chat');

interface Shortcut {
  id: 'help' | 'send' | 'newline' | 'slash' | 'escape';
  keys: string[];
}

const SHORTCUTS: Shortcut[] = [
  { id: 'help', keys: ['?'] },
  { id: 'send', keys: ['Enter'] },
  { id: 'newline', keys: ['Shift', 'Enter'] },
  { id: 'slash', keys: ['/'] },
  { id: 'escape', keys: ['Esc'] },
];

/** A help overlay listing the keyboard shortcuts, triggered by '?'. */
export function ShortcutsOverlay() {
  const { t } = useTranslation('chat');
  const { close } = useOverlays();
  const searchShortcutLabel = useKeyboardShortcutLabel('K');

  return (
    <Dialog open onOpenChange={open => !open && close('shortcuts')}>
      <DialogContent aria-label={t('shortcuts.title')}>
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ul className="flex flex-col gap-1">
            <li className="flex items-center justify-between gap-4 py-1.5">
              <Txt as="span" variant="body-sm" tone="ink">
                {t('shortcuts.search')}
              </Txt>
              <Kbd>{searchShortcutLabel}</Kbd>
            </li>
            {SHORTCUTS.map(s => (
              <li key={s.id} className="flex items-center justify-between gap-4 py-1.5">
                <Txt as="span" variant="body-sm" tone="ink">
                  {tk(`shortcuts.items.${s.id}`)}
                </Txt>
                <span className="flex shrink-0 items-center gap-1">
                  {s.keys.map(k => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
