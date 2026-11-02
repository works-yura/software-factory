import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ClickUpList } from '../../factory/services/clickup';
import { SourcePicker } from './IntakeSourcePicker';
import type { SourcePickerGroup } from './IntakeSourcePicker';

/** Group Lists by `Space / Folder` so same-named Lists stay distinguishable. */
function groupListsByPath(lists: ClickUpList[]): SourcePickerGroup[] {
  const groups = new Map<string, SourcePickerGroup>();
  for (const list of lists) {
    const group = groups.get(list.path) ?? { id: list.path, label: list.path, items: [] };
    group.items.push({ id: list.id, label: list.name });
    groups.set(list.path, group);
  }
  return [...groups.values()].toSorted((left, right) => (left.label ?? '').localeCompare(right.label ?? ''));
}

/**
 * Dialog for choosing which ClickUp Lists feed the factory: the chosen ones stay on top as removable
 * chips, the rest is a searchable list grouped by Space / Folder. A toggle saves at once.
 */
export function ClickUpListPicker({
  lists,
  selectedIds,
  busy,
  onToggle,
  onClose,
}: {
  lists: ClickUpList[];
  selectedIds: string[];
  busy: boolean;
  onToggle: (listId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const chosen = selectedIds.map(id => ({ id, list: lists.find(list => list.id === id) }));
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent size="lg" aria-label={t('intake.clickup.picker.title')}>
        <DialogHeader>
          <DialogTitle>{t('intake.clickup.picker.title')}</DialogTitle>
          <DialogDescription>{t('intake.clickup.picker.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            {chosen.length > 0 && (
              <ul aria-label={t('intake.clickup.picker.chosen')} className="flex flex-wrap gap-2">
                {chosen.map(({ id, list }) => (
                  <li key={id}>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t('intake.clickup.picker.remove', { name: list?.name ?? id })}
                      title={list ? `${list.path} / ${list.name}` : id}
                      onClick={() => onToggle(id)}
                      className="border-border1 hover:bg-surface-overlay-soft inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm"
                    >
                      {list?.name ?? id}
                      <X aria-hidden className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-border1 rounded-md border">
              <SourcePicker
                label={t('intake.clickup.lists')}
                groups={groupListsByPath(lists)}
                selectedIds={selectedIds}
                disabled={busy}
                pending={busy}
                onToggleItem={onToggle}
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Txt as="span" variant="caption" tone="muted" className="mr-auto">
            {t('intake.clickup.picker.count', { count: selectedIds.length })}
          </Txt>
          <Button variant="primary" onClick={onClose}>
            {t('intake.clickup.picker.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
