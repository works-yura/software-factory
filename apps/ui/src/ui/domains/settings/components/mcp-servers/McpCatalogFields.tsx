import type { McpCatalogField, McpCatalogVariant, McpLocalized } from '@factory/core';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { currentLanguage } from '../../../../i18n';
import type { McpCredentialOption, McpCredentialRef } from '../../services/mcpServers';

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
    if (!accounts.length) {
      return (
        <Txt as="p" variant="caption" tone="muted">
          {t('mcpServers.field.noAccounts')}
        </Txt>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Select
          value={picked?.id ?? ''}
          disabled={disabled}
          onValueChange={id => onChange({ ...values, credentials: { ...values.credentials, [field.key]: { kind: field.credential!, id } } })}
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
    <div className="flex w-full flex-col items-start gap-1">
      <Input
        aria-label={label}
        value={value}
        placeholder={field.default ? t('mcpServers.field.default', { value: field.default }) : ''}
        disabled={disabled}
        onChange={event => setInput(event.target.value)}
      />
      {suggestion && value !== suggestion && !disabled && (
        <Button size="sm" variant="ghost" onClick={() => setInput(suggestion)}>
          {t('mcpServers.field.suggest', { value: suggestion })}
        </Button>
      )}
    </div>
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
              suggestion={field.suggest ? suggestions[field.suggest] : undefined}
              disabled={disabled}
            />
          </SettingsRow>
        );
      })}
    </>
  );
}
