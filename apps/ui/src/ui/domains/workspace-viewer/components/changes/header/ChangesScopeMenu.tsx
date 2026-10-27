import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import type { WorkspaceChangesScope } from '../../../../../../api/types';

import { lazyLabels, lazyOption } from '../../../../../i18n/lazy';

const SCOPES = ['branch', 'uncommitted'] as const;

const SCOPE_LABELS: Readonly<Record<WorkspaceChangesScope, string>> = lazyLabels(
  SCOPES,
  scope => `workspaces:changes.scopes.${scope}`,
);

const SCOPE_OPTIONS = SCOPES.map(value => lazyOption<WorkspaceChangesScope>(value, `workspaces:changes.scopes.${value}`));

interface ChangesScopeMenuProps {
  scope: WorkspaceChangesScope;
  onScopeChange: (scope: WorkspaceChangesScope) => void;
}

export function ChangesScopeMenu({ scope, onScopeChange }: ChangesScopeMenuProps) {
  const [open, setOpen] = useState(false);
  const pickScope = (picked: WorkspaceChangesScope) => {
    setOpen(false);
    onScopeChange(picked);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger variant="ghost" size="sm" className="min-w-0">
        <span className="truncate">{SCOPE_LABELS[scope]}</span>
        <ChevronDown aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start">
        <DropdownMenu.RadioOptions options={SCOPE_OPTIONS} value={scope} onValueChange={pickScope} />
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
