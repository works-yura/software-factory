import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Building2, CircleUserRound, Server, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type SettingsScope = 'personal' | 'factory' | 'org' | 'deployment';

const SCOPE_BADGE: Record<SettingsScope, { variant: BadgeVariant; icon: LucideIcon }> = {
  personal: { variant: 'neutral', icon: CircleUserRound },
  factory: { variant: 'blue', icon: Building2 },
  org: { variant: 'blue', icon: Users },
  deployment: { variant: 'blue', icon: Server },
};

export function ScopeBadge({ scope }: { scope: SettingsScope }) {
  const { t } = useTranslation('settings');
  const { variant, icon: Icon } = SCOPE_BADGE[scope];
  const label = t(`scope.${scope}`);
  return (
    <Badge size="sm" variant={variant} icon={<Icon aria-hidden="true" />}>
      {label}
    </Badge>
  );
}
