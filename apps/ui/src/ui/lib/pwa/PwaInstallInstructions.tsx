import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@mastra/playground-ui/components/Drawer';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Menu, Share, Smartphone, SquarePlus } from 'lucide-react';
import type { ReactNode } from 'react';

import type { IosBrowser } from './platform';
import { detectIosBrowser } from './platform';
import { Trans, useTranslation } from 'react-i18next';

interface PwaInstallInstructionsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const emphasis = { em: <Txt as="span" variant="label" tone="ink" /> };

type StepKey = 'chromeShare' | 'menuShare' | 'safariShare' | 'addToHomeScreen' | 'confirmAdd';

function StepLabel({ i18nKey }: { i18nKey: `pwa.steps.${StepKey}` }) {
  return <Trans ns="app" i18nKey={i18nKey} components={emphasis} />;
}

/** Where the share menu lives differs per iOS browser. */
function shareStep(browser: IosBrowser): { icon: ReactNode; label: ReactNode } {
  switch (browser) {
    case 'chrome':
      return {
        icon: <Share className="size-4" aria-hidden="true" />,
        label: <StepLabel i18nKey="pwa.steps.chromeShare" />,
      };
    case 'firefox':
    case 'edge':
    case 'opera':
      return {
        icon: <Menu className="size-4" aria-hidden="true" />,
        label: <StepLabel i18nKey="pwa.steps.menuShare" />,
      };
    case 'safari':
      return {
        icon: <Share className="size-4" aria-hidden="true" />,
        label: <StepLabel i18nKey="pwa.steps.safariShare" />,
      };
  }
}

// Labels are components, so they render (and translate) at render time.
const commonSteps: Array<{ icon: ReactNode; label: ReactNode }> = [
  {
    icon: <SquarePlus className="size-4" aria-hidden="true" />,
    label: <StepLabel i18nKey="pwa.steps.addToHomeScreen" />,
  },
  {
    icon: <Smartphone className="size-4" aria-hidden="true" />,
    label: <StepLabel i18nKey="pwa.steps.confirmAdd" />,
  },
];

/** iOS/iPadOS has no install prompt; walk the user through Add to Home Screen. */
export function PwaInstallInstructions({ open, onOpenChange }: PwaInstallInstructionsProps) {
  const { t } = useTranslation('app');
  const steps = [shareStep(detectIosBrowser() ?? 'safari'), ...commonSteps];
  return (
    <Drawer open={open} onOpenChange={onOpenChange} side="bottom">
      <DrawerContent aria-label={t('pwa.instructionsTitle')}>
        <DrawerHeader>
          <div className="flex items-center gap-3">
            <div className="border-border bg-fill text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg border">
              <Smartphone className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <DrawerTitle>{t('pwa.instructionsTitle')}</DrawerTitle>
              <DrawerDescription>{t('pwa.instructionsDescription')}</DrawerDescription>
            </div>
          </div>
        </DrawerHeader>
        <DrawerBody>
          <ol className="flex flex-col">
            {steps.map((step, index) => (
              <li key={index} className="flex items-center gap-3 py-3">
                <Txt
                  as="span"
                  variant="meta"
                  tone="ink"
                  aria-hidden="true"
                  className="bg-fill flex size-6 shrink-0 items-center justify-center rounded-full tabular-nums"
                >
                  {index + 1}
                </Txt>
                <Txt tone="ink" as="span" variant="body" className="min-w-0 flex-1">
                  {step.label}
                </Txt>
                <span className="text-muted-foreground shrink-0">{step.icon}</span>
              </li>
            ))}
          </ol>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
