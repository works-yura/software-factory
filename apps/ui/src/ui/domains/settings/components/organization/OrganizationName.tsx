import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { FullOrganization } from '../../../auth/services/organization';
import { errorText } from '../../../../../lib/errorText';
import { useUpdateOrganization } from '../../hooks/useOrganization';

/** The organization's name: a field with Save for admins, the name as text for everyone else. */
export function OrganizationName({ organization, editable }: { organization: FullOrganization; editable: boolean }) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(organization.name);
  const rename = useUpdateOrganization(organization.id);
  const trimmed = name.trim();
  const changed = trimmed !== '' && trimmed !== organization.name;

  if (!editable) {
    return (
      <Txt as="span" variant="body" className="truncate" title={organization.name} data-testid="organization-name">
        {organization.name}
      </Txt>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (changed) rename.mutate({ name: trimmed });
  };
  return (
    <form onSubmit={submit} className="flex w-full min-w-0 flex-col items-start gap-2 sm:items-end">
      <div className="flex w-full min-w-0 items-center gap-2">
        <Input
          size="sm"
          className="min-w-0 flex-1"
          aria-label={t('organization.details.nameLabel')}
          data-testid="organization-name-input"
          value={name}
          maxLength={80}
          onChange={event => setName(event.target.value)}
        />
        <Button type="submit" size="sm" variant="primary" disabled={!changed || rename.isPending}>
          {rename.isPending ? t('organization.details.saving') : t('organization.details.save')}
        </Button>
      </div>
      {rename.isError ? (
        <Notice variant="destructive" role="alert" className="self-stretch">
          {t('organization.actionFailed', { message: errorText(rename.error) })}
        </Notice>
      ) : null}
    </form>
  );
}
