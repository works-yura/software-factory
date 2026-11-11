import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import { Txt } from '@mastra/playground-ui/components/Txt';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

export interface BreakdownView<V extends string> {
  value: V;
  label: string;
  /** Shown instead of `label` on narrow screens, where full labels overflow the strip. */
  shortLabel?: string;
  icon?: LucideIcon;
  description: string;
  content: ReactNode;
}

const PANEL_MOTION = [
  // grid panel — without minmax(0,…) its auto minimum is the longest untruncated title
  'grid-cols-[minmax(0,1fr)]',
  'overflow-visible transition-[opacity,transform] duration-300 ease-out',
  'data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0',
  'data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[ending-style]:duration-150',
  // outgoing panel out of flow — in flow both panels stack and the section balloons
  'data-[ending-style]:pointer-events-none data-[ending-style]:absolute data-[ending-style]:inset-x-0 data-[ending-style]:top-0',
  'motion-reduce:transition-none',
].join(' ');

/**
 * Several breakdowns of one subject as tabs of one section: the tab strip, the open view's one-line
 * description, and its panel, which slides in as the previous one fades out.
 */
export function BreakdownSection<V extends string>({
  title,
  views,
  defaultView,
}: {
  /** Heading for screen readers; the tabs name the section visually. */
  title: string;
  views: BreakdownView<V>[];
  defaultView: V;
}) {
  const [view, setView] = useState<V>(defaultView);
  const current = views.find(candidate => candidate.value === view) ?? views[0]!;
  return (
    <Tabs<V>
      defaultTab={defaultView}
      value={current.value}
      onValueChange={setView}
      className="flex flex-col gap-4 overflow-visible"
    >
      <h2 className="sr-only">{title}</h2>
      <div className="flex flex-col gap-2">
        {/* list + tab padding pulled into the gutter so labels sit on the text column */}
        <div className="-ml-3 max-w-full overflow-x-auto">
          <TabList variant="pill-ghost" size="sm" className="w-fit">
            {views.map(({ value, label, shortLabel, icon: Icon }) => (
              <Tab key={value} value={value}>
                {Icon ? <Icon aria-hidden="true" className="size-3.5" /> : null}
                {shortLabel ? (
                  <>
                    <span className="sm:hidden">{shortLabel}</span>
                    <span className="hidden sm:inline">{label}</span>
                  </>
                ) : (
                  label
                )}
              </Tab>
            ))}
          </TabList>
        </div>
        <Txt as="p" variant="body-sm" tone="muted" className="m-0">
          {current.description}
        </Txt>
      </div>

      <div className="relative">
        {views.map(({ value, content }) => (
          <TabContent key={value} value={value} className={PANEL_MOTION}>
            {content}
          </TabContent>
        ))}
      </div>
    </Tabs>
  );
}
