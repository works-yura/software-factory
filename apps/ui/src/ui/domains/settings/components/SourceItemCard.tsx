import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@mastra/playground-ui/components/Collapsible';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * One item a source feeds — a connected ClickUp List, a Factory's Firebase project. Collapsed it shows
 * the item and a one-line summary on the right, so a long list stays scannable; open, its settings.
 */
export function SourceItemCard({
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  summary: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="border-border1 rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left">
        <ChevronRight aria-hidden className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Txt as="span" variant="body" tone="ink" className="min-w-0 flex-1 truncate">
          {title}
        </Txt>
        <Txt as="span" variant="caption" tone="muted" className="shrink-0">
          {summary}
        </Txt>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border1 flex flex-col gap-5 border-t px-4 py-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
