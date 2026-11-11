// One harness instance's default model, as Settings → Models shows it for every harness alike: the
// model (the chat's picker, locked to the instance), its reasoning select, a control per other
// option the model offers, and "Use catalog default". Everything comes from the instance the
// server's model facet describes; nothing here names a harness.
import { Button } from '@mastra/playground-ui/components/Button';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { formatModelName } from '@mastra/playground-ui/utils/model';
import type { ModelSelection, ProviderInstanceId } from '@factory/harness/models/contracts';
import { selectableProviderOptionChoices } from '@factory/harness/models/modelTraits';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useApplyFactoryModelDefaultMutation,
  useSetFactoryModelDefaultMutation,
} from '../../../../../../hooks/useFactoryDefaultModel';
import { ProviderInstanceIcon } from '../../../../chat/components/modelPicker/ProviderInstanceIcon';
import { ProviderModelPicker } from '../../../../chat/components/modelPicker/ProviderModelPicker';
import type { ModelEsque } from '../../../../chat/components/modelPicker/providerIconUtils';
import { withDefaultMarked, type ProviderInstanceEntry } from '../../../../chat/components/modelPicker/providerInstances';
import {
  booleanValue,
  modelDefaultView,
  modelLabel,
  selectValue,
  withModel,
  withOption,
  type BooleanDescriptor,
  type SelectDescriptor,
} from './modelDefaultView';
import { SwitchRunningSessionsDialog } from './SwitchRunningSessionsDialog';

/** Up to this many choices sit side by side; more open as a menu. */
const SEGMENTED_MAX_CHOICES = 6;

const PICKER_TRIGGER =
  'w-full max-w-none border border-border bg-surface2 text-foreground hover:bg-surface3 sm:w-(--field-width)';

function writeFailure(error: unknown, t: (key: 'models.defaults.adminsOnly' | 'models.defaults.saveFailed') => string) {
  if (error instanceof Error && 'status' in error && error.status === 403) return t('models.defaults.adminsOnly');
  return error instanceof Error && error.message ? error.message : t('models.defaults.saveFailed');
}

export function HarnessModelDefaults({
  factoryId,
  entry,
}: {
  factoryId: string;
  entry: ProviderInstanceEntry;
}) {
  const { t } = useTranslation('settings');
  const save = useSetFactoryModelDefaultMutation(factoryId);
  const applyToSessions = useApplyFactoryModelDefaultMutation(factoryId);
  const [confirmModel, setConfirmModel] = useState<string>();
  const view = modelDefaultView(entry);
  const { selection } = view;
  const catalogName = modelLabel(entry, entry.catalogDefault);
  const pending = save.isPending;
  const headingId = `model-defaults-${entry.instanceId}`;

  const write = (next: ModelSelection | null, { newModel = false } = {}) => {
    applyToSessions.reset();
    save.mutate(
      { instanceId: entry.instanceId, selection: next },
      {
        onSuccess: () => {
          // A harness whose running sessions keep their model offers to move them onto a new one.
          if (next && newModel && entry.appliesToRunningSessions) setConfirmModel(modelLabel(entry, next) ?? next.model);
        },
      },
    );
  };

  const pickModel = (_instanceId: ProviderInstanceId, slug: string) => {
    const model = entry.models.find(candidate => candidate.slug === slug);
    if (!model || (view.isFactoryDefault && selection?.model === slug)) return;
    write(withModel(selection, entry.instanceId, model), { newModel: selection?.model !== slug });
  };

  const setOption = (id: string, value: string | boolean) => {
    if (!selection) return;
    write(withOption(selection, id, value));
  };

  // "Default" marks the catalog's default here: what "Use catalog default" goes back to. The stored
  // model stays listed, marked unavailable, when the catalog no longer has it.
  const catalogModels = withDefaultMarked(entry.models, entry.catalogDefault);
  const models: ReadonlyArray<ModelEsque> =
    selection && !view.model
      ? [...catalogModels, { slug: selection.model, name: formatModelName(selection.model), isUnavailable: true }]
      : catalogModels;
  const errorText = save.error
    ? writeFailure(save.error, t)
    : applyToSessions.error
      ? applyToSessions.error.message
      : undefined;

  return (
    <section aria-labelledby={headingId} data-instance-id={entry.instanceId}>
      <SettingsContainer>
        <SettingsRow
          label={
            <span id={headingId} className="flex items-center gap-2">
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                className="size-4"
                iconClassName="size-4"
              />
              {entry.displayName}
            </span>
          }
          description={
            view.isFactoryDefault
              ? t('models.defaults.setForFactory')
              : catalogName
                ? t('models.defaults.followsCatalog', { model: catalogName })
                : t('models.defaults.followsHarness')
          }
        >
          <div className="flex items-center justify-end gap-2">
            {pending && <Spinner size="sm" aria-label={t('models.defaults.saving')} className="text-muted-foreground" />}
            <Button
              variant="ghost"
              size="sm"
              disabled={!view.isFactoryDefault || pending}
              onClick={() => write(null)}
            >
              <RotateCcw aria-hidden />
              {t('models.defaults.useCatalogDefault')}
            </Button>
          </div>
        </SettingsRow>

        {!entry.isAvailable ? (
          <SettingsRow label={t('models.defaults.model')}>
            <Txt as="p" variant="caption" tone="muted" role="status">
              {entry.needsSetup
                ? t('models.defaults.needsSetup')
                : entry.reason
                  ? t('models.defaults.unavailableBecause', { harness: entry.displayName, reason: entry.reason })
                  : t('models.defaults.unavailable', { harness: entry.displayName })}
            </Txt>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow label={t('models.defaults.model')} description={t('models.defaults.modelDescription')}>
              <ProviderModelPicker
                activeInstanceId={entry.instanceId}
                model={selection?.model ?? ''}
                lockedProvider={entry.driverKind}
                instanceEntries={[entry]}
                modelOptionsByInstance={new Map([[entry.instanceId, models]])}
                triggerClassName={PICKER_TRIGGER}
                triggerAriaLabel={t('models.defaults.modelLabel', { harness: entry.displayName })}
                popupAlign="end"
                disabled={pending}
                onInstanceModelChange={pickModel}
              />
            </SettingsRow>
            {view.reasoning && (
              <OptionRow
                descriptor={view.reasoning}
                label={t('models.defaults.reasoning')}
                description={view.reasoning.description ?? t('models.defaults.reasoningDescription')}
                disabled={pending}
                onChange={setOption}
              />
            )}
            {view.others.map(descriptor => (
              <OptionRow
                key={descriptor.id}
                descriptor={descriptor}
                description={descriptor.description}
                disabled={pending}
                onChange={setOption}
              />
            ))}
          </>
        )}
      </SettingsContainer>
      {(errorText || applyToSessions.data) && (
        <div className="flex flex-col gap-1 px-1 pt-2">
          {errorText && (
            <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
              {errorText}
            </Txt>
          )}
          {applyToSessions.data && (
            <Txt as="p" variant="meta" role="status">
              {t('models.factoryDefault.switchStarted')}
            </Txt>
          )}
        </div>
      )}
      {confirmModel && (
        <SwitchRunningSessionsDialog
          modelName={confirmModel}
          pending={applyToSessions.isPending}
          onConfirm={() =>
            applyToSessions.mutate(entry.instanceId, { onSettled: () => setConfirmModel(undefined) })
          }
          onClose={() => setConfirmModel(undefined)}
        />
      )}
    </section>
  );
}

/** One option of the model: a switch for a toggle, side-by-side choices or a menu for a select. */
function OptionRow({
  descriptor,
  label = descriptor.label,
  description,
  disabled,
  onChange,
}: {
  descriptor: SelectDescriptor | BooleanDescriptor;
  /** The row's title; the descriptor's own label (as its harness names it) unless the UI translates it. */
  label?: string;
  description?: string | undefined;
  disabled: boolean;
  onChange: (id: string, value: string | boolean) => void;
}) {
  if (descriptor.type === 'boolean') {
    const checked = booleanValue(descriptor);
    return (
      <SettingsRow label={label} description={description}>
        <Switch
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onCheckedChange={next => {
            if (next !== checked) onChange(descriptor.id, next);
          }}
        />
      </SettingsRow>
    );
  }
  const choices = selectableProviderOptionChoices(descriptor);
  const value = selectValue(descriptor);
  const pick = (next: string) => {
    if (next !== value) onChange(descriptor.id, next);
  };
  return (
    <SettingsRow label={label} description={description}>
      {choices.length <= SEGMENTED_MAX_CHOICES ? (
        <SegmentedControl aria-label={label} size="sm" value={value} disabled={disabled} onValueChange={pick}>
          {choices.map(choice => (
            <SegmentedControlItem key={choice.id} value={choice.id} title={choice.description}>
              {choice.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      ) : (
        <Select value={value} disabled={disabled} onValueChange={next => typeof next === 'string' && pick(next)}>
          <SelectTrigger size="sm" aria-label={label} className="w-auto">
            <Txt as="span" variant="caption">
              {choices.find(choice => choice.id === value)?.label ?? value}
            </Txt>
          </SelectTrigger>
          <SelectContent>
            {choices.map(choice => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </SettingsRow>
  );
}
