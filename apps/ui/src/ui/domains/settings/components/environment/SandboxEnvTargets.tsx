import { Checkbox } from '@mastra/playground-ui/components/Checkbox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import type { SandboxEnvAppliesTo } from '../../../workspaces/services/sandbox-envs';

export type Targets = { build: boolean; runtime: boolean };

export function toTargets(appliesTo: SandboxEnvAppliesTo): Targets {
  return { build: appliesTo !== 'runtime', runtime: appliesTo !== 'build' };
}

export function toAppliesTo({ build, runtime }: Targets): SandboxEnvAppliesTo | undefined {
  if (build && runtime) return 'both';
  if (build) return 'build';
  if (runtime) return 'runtime';
  return undefined;
}

/** Where a variable applies: Build, Runtime or both; at least one. */
export function TargetsField({ value, onChange }: { value: Targets; onChange: (next: Targets) => void }) {
  const { t } = useTranslation('settings');
  const none = toAppliesTo(value) === undefined;
  return (
    <Field invalid={none}>
      <FieldLabel>{t('sandboxEnvs.appliesTo')}</FieldLabel>
      <div className="flex gap-4">
        <label className="flex items-center gap-2">
          <Checkbox
            aria-label={t('sandboxEnvs.build')}
            checked={value.build}
            onCheckedChange={checked => onChange({ ...value, build: checked === true })}
          />
          <Txt as="span" variant="body-sm">
            {t('sandboxEnvs.build')}
          </Txt>
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            aria-label={t('sandboxEnvs.runtime')}
            checked={value.runtime}
            onCheckedChange={checked => onChange({ ...value, runtime: checked === true })}
          />
          <Txt as="span" variant="body-sm">
            {t('sandboxEnvs.runtime')}
          </Txt>
        </label>
      </div>
      <FieldDescription>{t('sandboxEnvs.appliesToShort')}</FieldDescription>
      {none && <FieldError>{t('sandboxEnvs.pickOne')}</FieldError>}
    </Field>
  );
}
