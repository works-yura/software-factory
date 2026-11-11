import { Combobox } from '@mastra/playground-ui/components/Combobox';
import type { ComboboxOption } from '@mastra/playground-ui/components/Combobox';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/** Choices an account found (projects, databases); a refusal still carries what is known. */
export interface DiscoveredChoices {
  items: Array<{ value: string; label?: string; detail?: string }>;
  default?: string;
  denied?: { role?: string; message: string };
}

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** What the account found; `undefined` while nothing is picked yet or the lookup runs. */
  choices: DiscoveredChoices | undefined;
  loading?: boolean;
  /** A value to prefill before the found default (e.g. the Factory's own binding's project). */
  preferred?: string;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * A field filled from what the chosen account can see: a list to pick from that still takes any
 * typed value, prefilled with the obvious one while empty. A refused lookup leaves a muted hint
 * naming the role to grant; the field keeps working.
 */
export function DiscoveredChoice({ label, value, onChange, choices, loading, preferred, disabled, placeholder }: Props) {
  const { t } = useTranslation('settings');
  const suggested = preferred || choices?.default;

  useEffect(() => {
    if (!disabled && !value && suggested) onChange(suggested);
  }, [disabled, value, suggested, onChange]);

  const options: ComboboxOption[] = (choices?.items ?? []).map(item => ({
    value: item.value,
    label: item.label ? `${item.label} (${item.value})` : item.value,
    ...(item.detail ? { description: item.detail } : {}),
    keywords: [item.value, ...(item.label ? [item.label] : [])],
  }));
  if (value && !options.some(option => option.value === value)) options.unshift({ value, label: value });

  return (
    <div className="flex w-full flex-col items-start gap-1">
      <Combobox
        aria-label={label}
        options={options}
        value={value}
        onValueChange={onChange}
        allowCustomValue
        disabled={disabled}
        placeholder={loading ? t('discovery.loading') : (placeholder ?? t('discovery.placeholder'))}
        searchPlaceholder={t('discovery.search')}
        emptyText={t('discovery.empty')}
        className="w-full"
      />
      {choices?.denied && (
        <Txt as="span" variant="caption" tone="muted" role="note">
          {choices.denied.role ? t('discovery.deniedRole', { role: choices.denied.role }) : t('discovery.denied', { message: choices.denied.message })}
        </Txt>
      )}
    </div>
  );
}
