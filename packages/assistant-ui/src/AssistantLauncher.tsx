import { Button } from '@mastra/playground-ui/components/Button';
import { Drawer, DrawerContent } from '@mastra/playground-ui/components/Drawer';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantRequests } from './api';
import { AssistantPanel } from './AssistantPanel';

/**
 * The floating button on every page (ADR-0051), with the count of requests the assistant answered
 * since the person last looked. It opens the panel: a floating window on a desktop, a full-screen
 * drawer on a phone.
 */
export function AssistantLauncher({ hint }: { hint?: { id: string; name: string } }) {
  const { t } = useTranslation('assistant');
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const requests = useAssistantRequests();
  const unread = requests.data?.filter(request => request.unread).length ?? 0;

  const button = (
    <Button
      type="button"
      variant="primary"
      size="icon-lg"
      className="fixed right-4 bottom-4 z-40 shadow-lg"
      aria-label={unread > 0 ? `${t('launcher.open')} (${t('launcher.unread', { count: unread })})` : t('launcher.open')}
      aria-expanded={open}
      onClick={() => setOpen(current => !current)}
      data-testid="assistant-launcher"
    >
      <MessagesSquare aria-hidden="true" />
      {unread > 0 ? (
        <span className="bg-accent2 text-caption absolute -top-1 -right-1 min-w-5 rounded-full px-1 text-center text-white" aria-hidden="true">
          {unread}
        </span>
      ) : null}
    </Button>
  );

  if (isMobile) {
    return (
      <>
        {open ? null : button}
        <Drawer open={open} onOpenChange={setOpen} side="bottom">
          <DrawerContent showCloseButton={false} aria-label={t('panel.title')}>
            <div className="flex h-[100dvh] flex-col pb-[env(safe-area-inset-bottom)]">
              <AssistantPanel compact hint={hint} onClose={() => setOpen(false)} />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <>
      {button}
      {open ? (
        <div
          role="dialog"
          aria-label={t('panel.title')}
          className="border-border bg-surface2 fixed right-4 bottom-20 z-40 flex h-[min(42rem,calc(100dvh-7rem))] w-[min(60rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border shadow-xl"
        >
          <AssistantPanel hint={hint} onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  );
}
