import { MCP_SUGGESTION_CONTEXT, mcpSuggestionContext } from '@factory/core';
import type { McpCatalogField, McpCatalogVariant, McpLocalized, McpSuggestion } from '@factory/core';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsRow } from '@mastra/playground-ui/new/settings';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMcpDiscovery } from '../../../../../hooks/useMcpServers';
import { currentLanguage } from '../../../../i18n';
import { DiscoveredChoice } from '../DiscoveredChoice';
import type { McpCredentialOption, McpCredentialRef } from '../../services/mcpServers';
import { AccountKeyDialog } from '../GoogleCloudService';

/** A catalog text in the person's language. */
export const localized = (text: McpLocalized) => (currentLanguage() === 'uk' ? text.uk : text.en);

export interface CatalogFieldValues {
  /** Plain values by input key. */
  inputs: Record<string, string>;
  /** Account picks by input key. */
  credentials: Record<string, McpCredentialRef>;
  /** Secret values typed in this edit (sent once, never shown again). */
  secrets: Record<string, string>;
}

interface Props {
  variant: McpCatalogVariant;
  values: CatalogFieldValues;
  onChange: (next: CatalogFieldValues) => void;
  /** Names of the secret inputs already stored for this server. */
  storedSecrets: string[];
  accounts: Partial<Record<McpCredentialRef['kind'], McpCredentialOption[]>>;
  suggestions: Partial<Record<'google-cloud-project', string>>;
  disabled: boolean;
}

function FieldControl({
  field,
  values,
  onChange,
  stored,
  accounts,
  suggestion,
  disabled,
}: {
  field: McpCatalogField;
  values: CatalogFieldValues;
  onChange: (next: CatalogFieldValues) => void;
  stored: boolean;
  accounts: McpCredentialOption[];
  suggestion: string | undefined;
  disabled: boolean;
}) {
  const { t } = useTranslation('settings');
  const label = localized(field.label);

  if (field.credential) {
    const picked = values.credentials[field.key];
    const name = accounts.find(account => account.id === picked?.id)?.name;
    const pick = (id: string) => onChange({ ...values, credentials: { ...values.credentials, [field.key]: { kind: field.credential!, id } } });
    // A Google Cloud account is added right here, with the same dialog as in Інтеграції › Google Cloud.
    const addAccount =
      field.credential === 'google-cloud-account' && !disabled ? <AddGoogleCloudAccount onAdded={pick} /> : null;
    if (!accounts.length) {
      return (
        <div className="flex flex-col items-start gap-1">
          <Txt as="p" variant="caption" tone="muted">
            {t('mcpServers.field.noAccounts')}
          </Txt>
          {addAccount}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
        <Select
          value={picked?.id ?? ''}
          disabled={disabled}
          onValueChange={pick}
        >
          <SelectTrigger aria-label={label} className="w-72">
            {name ?? t('mcpServers.field.pickAccount')}
          </SelectTrigger>
          <SelectContent>
            {accounts.map(account => (
              <SelectItem key={account.id} value={account.id}>
                {account.detail ? `${account.name} · ${account.detail}` : account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {addAccount}
        </div>
        {!picked && stored && (
          <Txt as="span" variant="caption" tone="muted">
            {t('mcpServers.field.pastedKey')}
          </Txt>
        )}
      </div>
    );
  }

  if (field.secret) {
    const setSecret = (value: string) => onChange({ ...values, secrets: { ...values.secrets, [field.key]: value } });
    const placeholder = stored ? t('mcpServers.field.secretKeep') : '';
    return field.file ? (
      <Textarea aria-label={label} rows={4} placeholder={placeholder} value={values.secrets[field.key] ?? ''} disabled={disabled} onChange={event => setSecret(event.target.value)} />
    ) : (
      <Input aria-label={label} type="password" autoComplete="off" placeholder={placeholder} value={values.secrets[field.key] ?? ''} disabled={disabled} onChange={event => setSecret(event.target.value)} />
    );
  }

  const setInput = (value: string) => onChange({ ...values, inputs: { ...values.inputs, [field.key]: value } });
  const value = values.inputs[field.key] ?? '';

  if (field.suggest) {
    return (
      <SuggestedInput
        field={field}
        suggest={field.suggest}
        values={values}
        value={value}
        onInput={setInput}
        preferred={field.suggest.from === 'google-cloud-projects' ? suggestion : undefined}
        disabled={disabled}
      />
    );
  }

  if (field.choices?.length) {
    return (
      <Select value={value} disabled={disabled} onValueChange={setInput}>
        <SelectTrigger aria-label={label} className="w-56">
          {value || field.default || t('mcpServers.field.pickChoice')}
        </SelectTrigger>
        <SelectContent>
          {field.choices.map(choice => (
            <SelectItem key={choice} value={choice}>
              {choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      aria-label={label}
      value={value}
      placeholder={field.default ? t('mcpServers.field.default', { value: field.default }) : ''}
      disabled={disabled}
      onChange={event => setInput(event.target.value)}
    />
  );
}

/**
 * An input whose choices come from the account another input picked (the projects it sees, a
 * project's databases), as the catalog overlay declares: idle until that account is chosen.
 */
function SuggestedInput({
  field,
  suggest,
  values,
  value,
  onInput,
  preferred,
  disabled,
}: {
  field: McpCatalogField;
  suggest: McpSuggestion;
  values: CatalogFieldValues;
  value: string;
  onInput: (value: string) => void;
  preferred: string | undefined;
  disabled: boolean;
}) {
  const credential = values.credentials[suggest.dependsOn[0]!];
  const context = mcpSuggestionContext(suggest, values.inputs);
  const needsContext = MCP_SUGGESTION_CONTEXT[suggest.from].some(name => !context[name]);
  const discovery = useMcpDiscovery(credential && !needsContext ? { credential, from: suggest.from, context } : undefined);
  return (
    <DiscoveredChoice
      label={localized(field.label)}
      value={value}
      onChange={onInput}
      choices={discovery.data}
      loading={discovery.isFetching}
      preferred={preferred}
      disabled={disabled}
      {...(field.default ? { placeholder: field.default } : {})}
    />
  );
}

/** «+ Додати акаунт»: the Google Cloud account dialog, then the new account is picked. */
function AddGoogleCloudAccount({ onAdded }: { onAdded: (accountId: string) => void }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t('mcpServers.field.addAccount')}
      </Button>
      {open && <AccountKeyDialog onClose={() => setOpen(false)} onAdded={account => onAdded(account.id)} />}
    </>
  );
}

/** The inputs one way of running a catalog server declares, as form rows in the person's language. */
export function McpCatalogFields({ variant, values, onChange, storedSecrets, accounts, suggestions, disabled }: Props) {
  const { t } = useTranslation('settings');
  return (
    <>
      {variant.fields.map(field => {
        const stored = storedSecrets.includes(field.key);
        const description = [
          field.description ? localized(field.description) : undefined,
          field.required ? t('mcpServers.field.required') : undefined,
          field.secret && !field.credential && stored ? t('mcpServers.field.secretStored') : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <SettingsRow key={field.key} label={localized(field.label)} description={description}>
            <FieldControl
              field={field}
              values={values}
              onChange={onChange}
              stored={stored}
              accounts={field.credential ? (accounts[field.credential] ?? []) : []}
              suggestion={field.suggest?.from === 'google-cloud-projects' ? suggestions['google-cloud-project'] : undefined}
              disabled={disabled}
            />
          </SettingsRow>
        );
      })}
    </>
  );
}
