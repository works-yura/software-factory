import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import type { ReactNode } from 'react';

/**
 * Grows a finger's control to a 40px hit area without changing how it looks: a transparent layer
 * 4px past each edge of a 32px (`icon-lg`) button. Used only beside a gap at least that wide, so
 * neighbouring hit areas never overlap.
 */
export const TOUCH_TARGET = "relative after:absolute after:-inset-1 after:content-['']";

/**
 * The composer's buttons (attach, send or stop), in the footer's bottom-right corner. With a mouse
 * they are one compact pill; with a finger they stand apart at 32px with a 40px hit area each.
 */
export function ComposerSendButtons({ label, touch, children }: { label: string; touch: boolean; children: ReactNode }) {
  if (touch) {
    return (
      <div role="group" aria-label={label} className="ml-auto flex shrink-0 items-center gap-2 self-end">
        {children}
      </div>
    );
  }
  return (
    <ButtonsGroup size="sm" className="ml-auto shrink-0 self-end" aria-label={label}>
      {children}
    </ButtonsGroup>
  );
}
