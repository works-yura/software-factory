import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { ASSIGNABLE_ROLES } from '../../../auth/services/organization';
import type { AssignableRole, OrganizationRole } from '../../../auth/services/organization';

const ROLE_BADGE: Record<OrganizationRole, BadgeVariant> = {
  owner: 'purple',
  admin: 'info',
  member: 'neutral',
  viewer: 'neutral',
};

/**
 * A role as people read it: Глядач, Учасник, Адмін. The owner (the organization's creator) is an
 * admin with an «власник» note: the role nobody else is given and nobody changes.
 */
export function RoleBadge({ role }: { role: OrganizationRole }) {
  const { t } = useTranslation('settings');
  return (
    <span className="flex items-center gap-1">
      <Badge size="sm" variant={ROLE_BADGE[role]}>
        {t(`organization.roles.${role}`)}
      </Badge>
      {role === 'owner' ? (
        <Txt as="span" variant="caption" tone="muted">
          {t('organization.roles.ownerNote')}
        </Txt>
      ) : null}
    </span>
  );
}

/** Viewer, Member or Admin, each with what it may do. */
export function RoleSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: AssignableRole;
  onChange: (role: AssignableRole) => void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={next => {
        if (next && (ASSIGNABLE_ROLES as readonly string[]).includes(next)) onChange(next as AssignableRole);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-fit min-w-28">
        <Txt as="span" variant="caption">
          {t(`organization.roles.${value}`)}
        </Txt>
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_ROLES.map(role => (
          <SelectItem key={role} value={role}>
            <span className="flex flex-col">
              <span>{t(`organization.roles.${role}`)}</span>
              <Txt as="span" variant="caption" tone="muted">
                {t(`organization.roleDescriptions.${role}`)}
              </Txt>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
