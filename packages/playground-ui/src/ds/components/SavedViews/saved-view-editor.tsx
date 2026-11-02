import type { ReactNode } from 'react';
import type { SavedViewsController } from './use-saved-views';
import { Button } from '@/ds/components/Button/Button';
import { Txt } from '@/ds/components/Txt';
import { cn } from '@/lib/utils';
import { libText } from '@/lib/lib-text';

export type SavedViewEditorProps<TSettings> = {
  views: SavedViewsController<TSettings>;
  children?: ReactNode;
  className?: string;
};

export function SavedViewEditor<TSettings>({ views, children, className }: SavedViewEditorProps<TSettings>) {
  const { draft } = views;
  const creating = draft?.viewId === undefined;
  return (
    <div
      role={draft ? 'group' : undefined}
      aria-label={draft ? `Edit view ${draft.name}` : undefined}
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
    >
      {children}
      {draft && (
        <>
          {!creating && views.unsaved && (
            <Txt as="span" variant="caption" tone="muted">
              {libText('Unsaved changes')}
            </Txt>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {creating && (
              <Txt as="span" variant="caption" tone="muted" className="max-sm:hidden">
                {libText('Saved in this browser')}
              </Txt>
            )}
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={views.discard}>
                {creating ? libText('Cancel') : libText('Reset')}
              </Button>
              <Button type="button" variant="primary" size="sm" disabled={!views.unsaved} onClick={views.save}>
                {creating ? libText('Save view') : libText('Save changes')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
