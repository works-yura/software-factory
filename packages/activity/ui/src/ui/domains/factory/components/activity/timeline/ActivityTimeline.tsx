import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { LayoutGrid, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PropertiesMenu } from '../../../../../ui/PropertiesMenu';
import type { ActivityGrouping } from '../../../activity';
import { lazyOption } from '../../../../../i18n/lazy';
import type { AuditNamespace } from '../../../auditPresentation';
import { FactoryFeed } from '../feed/FactoryFeed';
import { AuditPortalItem } from './AuditPortalItem';
import { CategoryFilter } from './CategoryFilter';
import { setCompactTimeline, useCompactTimeline } from './compactTimeline';
import { useTimelineGrouping } from './useTimelineGrouping';

const GROUPING_OPTIONS = [
  lazyOption<ActivityGrouping>('similar', 'activity:timeline.grouping.similar'),
  lazyOption<ActivityGrouping>('none', 'activity:timeline.grouping.none'),
] satisfies Array<{ value: ActivityGrouping; label: string }>;

export function ActivityTimeline({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('activity');
  const [grouping, setGrouping] = useTimelineGrouping();
  const compact = useCompactTimeline();
  const [categories, setCategories] = useState<ReadonlySet<AuditNamespace>>(() => new Set());
  const changedCount = [grouping !== 'similar', compact, categories.size > 0].filter(Boolean).length;

  const reset = () => {
    setGrouping('similar');
    setCompactTimeline(false);
    setCategories(new Set());
  };

  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-4">
      <div className="min-h-control-sm flex items-center gap-2">
        <Txt as="h2" variant="column" tone="ink" id="timeline-heading" className="m-0">
          {t('timeline.title')}
        </Txt>
        <span className="ml-auto">
          <PropertiesMenu label={t('timeline.properties')} align="end" changedCount={changedCount} onReset={reset}>
            <DropdownMenu.RadioSub
              label={t('timeline.group')}
              icon={<LayoutGrid aria-hidden />}
              options={GROUPING_OPTIONS}
              value={grouping}
              onValueChange={setGrouping}
            />
            <CategoryFilter categories={categories} onChange={setCategories} />
            <DropdownMenu.CheckboxItem checked={compact} onCheckedChange={setCompactTimeline}>
              <Rows3 aria-hidden />
              <span>{t('timeline.compact')}</span>
            </DropdownMenu.CheckboxItem>
            <AuditPortalItem />
          </PropertiesMenu>
        </span>
      </div>
      <FactoryFeed
        factoryId={factoryId}
        grouping={grouping}
        compact={compact}
        categories={categories}
        onClearCategories={() => setCategories(new Set())}
      />
    </section>
  );
}
