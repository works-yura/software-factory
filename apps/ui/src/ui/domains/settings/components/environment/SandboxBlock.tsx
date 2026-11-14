import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsRow } from '@mastra/playground-ui/new/settings';

import type { FactoryEnvironmentPayload } from '../../../workspaces/services/environment';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { useTranslation } from 'react-i18next';

import { translator } from '../../../../i18n/t';

import { CommittedInput } from './CommittedInput';
import type { SaveEnvironment } from './CommittedInput';

/** The JSON Schema subset the settings renderer reads; anything else renders as unsupported. */
interface SettingSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  oneOf?: Array<{ const?: unknown; title?: string }>;
}

interface Choice {
  value: unknown;
  label: string;
}

/** Select options from `enum`, or from a `oneOf` of `const` members whose `title` is the label. */
function schemaChoices(schema: SettingSchema): Choice[] | undefined {
  if (schema.enum) return schema.enum.map(value => ({ value, label: String(value) }));
  if (schema.oneOf?.length && schema.oneOf.every(member => 'const' in member)) {
    return schema.oneOf.map(member => ({ value: member.const, label: member.title ?? String(member.const) }));
  }
  return undefined;
}

const tk = translator('settings');

/** Product names shown as they are; other known providers have a sentence of their own. */
const PROVIDER_NAMES: Record<string, string> = { e2b: 'E2B', docker: 'Docker' };

/** "Sandboxes run on E2B" for a known provider id, the raw id otherwise. */
export function providerLine(provider: string): string {
  switch (provider) {
    case 'platform':
      return tk('environment.provider.platform');
    case 'local':
      return tk('environment.provider.local');
    case 'custom':
      return tk('environment.provider.custom');
    case 'none':
      return tk('environment.provider.none');
    default:
      return tk('environment.provider.named', { provider: PROVIDER_NAMES[provider] ?? provider });
  }
}

function schemaProperties(schema: Record<string, unknown>): Array<[string, SettingSchema]> {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.entries(properties as Record<string, SettingSchema>);
}

/**
 * The provider's own sandbox settings, one row per property of the schema the
 * route serves, rendered inside the caller's container. Each row commits its
 * own PATCH; an empty field means the provider default (the placeholder),
 * never a value factory stores on the user's behalf.
 */
export function SandboxBlock({
  environment,
  disabled,
  onSave,
}: {
  environment: FactoryEnvironmentPayload;
  disabled: boolean;
  onSave: SaveEnvironment;
}) {
  const saveSetting = (key: string, value: unknown | null) => onSave({ settings: { [key]: value } });
  return schemaProperties(environment.sandbox.settingsSchema).map(([key, schema]) => (
    <SettingRow
      key={key}
      name={key}
      schema={schema}
      value={environment.settings[key]}
      disabled={disabled}
      onCommit={value => saveSetting(key, value)}
    />
  ));
}

function SettingRow({
  name,
  schema,
  value,
  disabled,
  onCommit,
}: {
  name: string;
  schema: SettingSchema;
  value: unknown;
  disabled: boolean;
  onCommit: (value: unknown | null) => Promise<boolean>;
}) {
  const { t } = useTranslation('settings');
  const label = t(`environment.sandbox.settingLabels.${name}`, { defaultValue: schema.title ?? name });
  const description = schema.description
    ? t(`environment.sandbox.settingDescriptions.${name}`, { defaultValue: schema.description })
    : undefined;
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  const placeholder = schema.default === undefined ? undefined : String(schema.default);
  const choices = schemaChoices(schema);
  let control: React.ReactNode;
  if (choices) {
    // A default that is one of the choices is marked on that choice, and picking it clears the setting;
    // otherwise a separate "Default" item does.
    const defaultIsChoice = choices.some(choice => String(choice.value) === placeholder);
    const unsetKey = defaultIsChoice ? placeholder! : UNSET;
    const labelOf = (key: string) => {
      const choiceLabel = choices.find(choice => String(choice.value) === key)?.label ?? key;
      return defaultIsChoice && key === placeholder
        ? t('environment.sandbox.defaultChoice', { label: choiceLabel })
        : choiceLabel;
    };
    const current = value === undefined ? unsetKey : String(value);
    const defaultLabel = placeholder
      ? t('environment.sandbox.defaultWithValue', { value: placeholder })
      : t('environment.sandbox.default');
    control = (
      <Select
        value={current}
        disabled={disabled}
        onValueChange={next => void onCommit(next === unsetKey ? null : coerceChoice(choices, next))}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <Txt as="span" variant="caption">
            {current === UNSET ? defaultLabel : labelOf(current)}
          </Txt>
        </SelectTrigger>
        <SelectContent>
          {!defaultIsChoice && (
            <SelectItem value={UNSET}>{defaultLabel}</SelectItem>
          )}
          {choices.map(choice => (
            <SelectItem key={String(choice.value)} value={String(choice.value)}>
              {labelOf(String(choice.value))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (type === 'boolean') {
    control = (
      <Switch
        aria-label={label}
        checked={value === undefined ? schema.default === true : value === true}
        disabled={disabled}
        onCheckedChange={next => void onCommit(next)}
      />
    );
  } else if (type === 'integer' || type === 'number') {
    control = (
      <CommittedInput
        label={label}
        type="number"
        min={schema.minimum}
        max={schema.maximum}
        step={type === 'integer' ? 1 : 'any'}
        placeholder={placeholder}
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        onCommit={raw => {
          if (raw === '') return onCommit(null);
          const parsed = numberInRange(raw, schema, type === 'integer');
          return parsed === undefined ? Promise.reject(new Error('invalid')) : onCommit(parsed);
        }}
      />
    );
  } else if (type === 'string') {
    control = (
      <CommittedInput
        label={label}
        placeholder={placeholder}
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        onCommit={raw => onCommit(raw === '' ? null : raw)}
      />
    );
  } else {
    control = (
      <Txt as="span" variant="meta" tone="faint">
        {t('environment.sandbox.unsupported')}
      </Txt>
    );
  }
  return (
    <SettingsRow label={label} description={description}>
      {control}
    </SettingsRow>
  );
}

const UNSET = '__default__';

/**
 * The parsed number when it satisfies the schema's type and bounds, otherwise
 * undefined after telling the user why the value was not saved. `Number()`
 * rejects "12abc" where parseInt would have silently truncated it.
 */
function numberInRange(raw: string, schema: SettingSchema, integer: boolean): number | undefined {
  const value = Number(raw);
  const typed = integer ? Number.isInteger(value) : Number.isFinite(value);
  const min = schema.minimum ?? -Infinity;
  const max = schema.maximum ?? Infinity;
  if (typed && value >= min && value <= max) return value;
  const bounds = { min: schema.minimum, max: schema.maximum };
  const message =
    schema.minimum !== undefined && schema.maximum !== undefined
      ? integer
        ? tk('environment.sandbox.enterInteger.between', bounds)
        : tk('environment.sandbox.enterNumber.between', bounds)
      : schema.minimum !== undefined
        ? integer
          ? tk('environment.sandbox.enterInteger.atLeast', bounds)
          : tk('environment.sandbox.enterNumber.atLeast', bounds)
        : schema.maximum !== undefined
          ? integer
            ? tk('environment.sandbox.enterInteger.atMost', bounds)
            : tk('environment.sandbox.enterNumber.atMost', bounds)
          : integer
            ? tk('environment.sandbox.enterInteger.any')
            : tk('environment.sandbox.enterNumber.any');
  toast.error(message);
  return undefined;
}

/** The choice whose string form the select handed back, keeping its original type. */
function coerceChoice(choices: Choice[], picked: string): unknown {
  return choices.find(choice => String(choice.value) === picked)?.value ?? picked;
}
