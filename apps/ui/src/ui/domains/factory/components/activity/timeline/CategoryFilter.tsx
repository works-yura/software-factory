import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { ListFilter } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AUDIT_CATEGORIES } from '../../../auditPresentation';
import type { AuditNamespace } from '../../../auditPresentation';
import { translator } from '../../../../../i18n/t';

const ta = translator('activity');

/** The category labels in `AUDIT_CATEGORIES` are English; the filter shows them in the current language. */
function categoryLabel(namespace: AuditNamespace): string {
  switch (namespace) {
    case 'work_item':
      return ta('timeline.categories.work_item');
    case 'run':
      return ta('timeline.categories.run');
    case 'git':
      return ta('timeline.categories.git');
    case 'agent':
      return ta('timeline.categories.agent');
    case 'intake':
      return ta('timeline.categories.intake');
  }
}

function filterHint(categories: ReadonlySet<AuditNamespace>): string {
  if (categories.size === 0) return ta('timeline.all');
  const [only] = AUDIT_CATEGORIES.filter(category => categories.has(category.namespace));
  return categories.size === 1 && only ? categoryLabel(only.namespace) : ta('timeline.kinds', { count: categories.size });
}

/** Every category picked is the same as none, so the filter folds back to "All". */
function toggled(categories: ReadonlySet<AuditNamespace>, category: AuditNamespace): ReadonlySet<AuditNamespace> {
  const next = new Set(categories);
  if (!next.delete(category)) next.add(category);
  return next.size === AUDIT_CATEGORIES.length ? new Set() : next;
}

export function CategoryFilter({
  categories,
  onChange,
}: {
  categories: ReadonlySet<AuditNamespace>;
  onChange: (categories: ReadonlySet<AuditNamespace>) => void;
}) {
  const { t } = useTranslation('activity');
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger hint={filterHint(categories)}>
        <ListFilter aria-hidden />
        <span>{t('timeline.filter')}</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent>
        <DropdownMenu.CheckboxItem checked={categories.size === 0} onCheckedChange={() => onChange(new Set())}>
          {t('timeline.allEvents')}
        </DropdownMenu.CheckboxItem>
        <DropdownMenu.Separator />
        {AUDIT_CATEGORIES.map(category => (
          <DropdownMenu.CheckboxItem
            key={category.namespace}
            checked={categories.has(category.namespace)}
            onCheckedChange={() => onChange(toggled(categories, category.namespace))}
          >
            <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${category.dotClass}`} />
            {categoryLabel(category.namespace)}
          </DropdownMenu.CheckboxItem>
        ))}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}
