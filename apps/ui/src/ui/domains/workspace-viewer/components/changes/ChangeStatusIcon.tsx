import { SquareArrowRight, SquareDot, SquareMinus, SquarePlus, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { WorkspaceChangeStatus } from '../../../../../api/types';

import { translator } from '../../../../i18n/t';

const tk = translator('workspaces');

const STATUS_ICONS: Record<WorkspaceChangeStatus, { Icon: LucideIcon; className: string }> = {
  modified: { Icon: SquareDot, className: 'text-warning-indicator' },
  added: { Icon: SquarePlus, className: 'text-success-indicator' },
  untracked: { Icon: SquarePlus, className: 'text-success-indicator' },
  copied: { Icon: SquarePlus, className: 'text-success-indicator' },
  deleted: { Icon: SquareMinus, className: 'text-destructive-indicator' },
  renamed: { Icon: SquareArrowRight, className: 'text-info-indicator' },
  conflicted: { Icon: TriangleAlert, className: 'text-destructive-indicator' },
};

export function ChangeStatusIcon({ status }: { status: WorkspaceChangeStatus }) {
  const { Icon, className } = STATUS_ICONS[status];
  return <Icon role="img" aria-label={tk(`changes.statuses.${status}`)} className={className} />;
}
