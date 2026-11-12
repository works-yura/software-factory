import type { ConnectionDetailSection, ConnectionSettingField, ConnectionSettingsValues } from '@factory/contracts';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUpdateConnectionSettings } from '../../../../../hooks/useConnections';
import { ConnectionApiError } from '../../connections/api';
import { FormField } from './ConnectorSteps';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type SettingsSection = Extract<ConnectionDetailSection, { type: 'settings' }>;

const initialValues = (fields: readonly ConnectionSettingField[]): ConnectionSettingsValues =>
  Object.fromEntries(fields.map(field => [field.name, field.value]));

/**
 * A `settings` section the server laid out: switches save as they change (no `saveLabel`), other
 * fields — text, secret, textarea, file, select — are saved together with the section's button. A
 * field the server keeps from this person is disabled with its reason; a refusal shows on its field.
 */
export function ConnectorSettings({ connectionId, section }: { connectionId: string; section: SettingsSection }) {
  const { t } = useTranslation('settings');
  const update = useUpdateConnectionSettings();
  const [values, setValues] = useState<ConnectionSettingsValues>(() => initialValues(section.fields));
  const fieldErrors = update.error instanceof ConnectionApiError ? (update.error.body.fields ?? {}) : {};
  const save = (next: ConnectionSettingsValues) =>
    update.mutate(
      { id: connectionId, section: section.id, values: next },
      {
        onSuccess: result => toast.success(result.message),
        onError: error => {
          if (!section.saveLabel) {
            setValues(initialValues(section.fields));
            toast.error(errorMessage(error));
          }
        },
      },
    );
  const set = (field: ConnectionSettingField, value: string | boolean) => {
    const next = { ...values, [field.name]: value };
    setValues(next);
    if (!section.saveLabel) save({ [field.name]: value });
  };

  const row = (field: ConnectionSettingField) => {
    const reason = field.disabled?.reason;
    const disabled = reason !== undefined || update.isPending;
    if (field.type === 'boolean') {
      return (
        <SettingsRow key={field.name} label={field.displayName} {...((reason ?? field.description) ? { description: reason ?? field.description } : {})}>
          <Switch aria-label={field.displayName} checked={values[field.name] === true} disabled={disabled} onCheckedChange={checked => set(field, checked)} />
        </SettingsRow>
      );
    }
    if (field.type === 'select') {
      const value = typeof values[field.name] === 'string' ? (values[field.name] as string) : '';
      return (
        <SettingsRow key={field.name} label={field.displayName} {...((reason ?? field.description) ? { description: reason ?? field.description } : {})}>
          <Select value={value} disabled={disabled} onValueChange={next => set(field, next)}>
            <SelectTrigger aria-label={field.displayName} className="w-56">
              {field.options?.find(option => option.value === value)?.label ?? field.placeholder ?? '—'}
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      );
    }
    return (
      <div key={field.name} className="px-4 py-3">
        <FormField
          field={reason ? { ...field, description: reason } : field}
          value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
          {...(fieldErrors[field.name] ? { error: fieldErrors[field.name] } : {})}
          onChange={next => set(field, next)}
        />
      </div>
    );
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={event => {
        event.preventDefault();
        save(values);
      }}
    >
      <SettingsContainer>{section.fields.map(row)}</SettingsContainer>
      {section.saveLabel && update.isError && Object.keys(fieldErrors).length === 0 && (
        <Notice variant="destructive" title={t('connections.connector.saveFailed')} role="alert">
          <Notice.Message>{errorMessage(update.error)}</Notice.Message>
        </Notice>
      )}
      {section.saveLabel && (
        <Button type="submit" size="sm" variant="primary" className="self-end" disabled={update.isPending}>
          {section.saveLabel}
        </Button>
      )}
    </form>
  );
}
