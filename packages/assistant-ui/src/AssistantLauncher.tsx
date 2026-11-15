import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Drawer, DrawerContent } from '@mastra/playground-ui/components/Drawer';
import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantRequests } from './api';
import { AssistantPanel } from './AssistantPanel';

/** The only ways the desktop panel closes on its own: its button, Escape. Not a press outside, not focus leaving. */
const LAUNCHER_CLOSE_REASONS: ReadonlySet<string> = new Set(['trigger-press', 'escape-key']);

/** Where the floating button sits: over every page, in the bottom-right corner. */
const LAUNCHER_PLACE = 'fixed right-4 bottom-4 z-40';

/**
 * The floating button on every page (ADR-0051), with the count of requests the assistant answered
 * since the person last looked. It opens the panel: a popover window anchored to the button on a
 * desktop, a bottom drawer on a phone.
 */
export function AssistantLauncher({ hint }: { hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const requests = useAssistantRequests();
  const unread = requests.data?.filter(request => request.unread).length ?? 0;
  const close = () => setOpen(false);

  const trigger = {
    'aria-label': unread > 0 ? `${t('launcher.open')} (${t('launcher.unread', { count: unread })})` : t('launcher.open'),
    'data-testid': 'assistant-launcher',
    children: (
      <>
        <MessagesSquare />
        {unread > 0 ? (
          <Badge size="xs" variant="destructive" className="absolute -top-1 -right-1" aria-hidden="true">
            {unread}
          </Badge>
        ) : null}
      </>
    ),
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen} side="bottom">
        {open ? null : <Button variant="primary" size="icon-lg" className={LAUNCHER_PLACE} onClick={() => setOpen(true)} {...trigger} />}
        <DrawerContent showCloseButton={false} aria-label={t('panel.title')} className="h-[calc(85dvh+3rem)] pb-[calc(3rem+env(safe-area-inset-bottom))]">
          <AssistantPanel compact hint={hint} onClose={close} />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // The panel stays open while the person works on the page beside it (copying what to paste),
        // and while focus wanders (a click inside on Safari focuses nothing; a picker's portal takes
        // focus): only the button and Escape close it, and its own close button (`close`).
        if (!next && !LAUNCHER_CLOSE_REASONS.has(details.reason)) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger variant="primary" size="icon-lg" className={LAUNCHER_PLACE} {...trigger} />
      <PopoverContent
        aria-label={t('panel.title')}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className="flex h-[min(42rem,var(--available-height))] w-[min(60rem,var(--available-width))] flex-col overflow-hidden p-0"
      >
        <AssistantPanel hint={hint} onClose={close} />
      </PopoverContent>
    </Popover>
  );
}
