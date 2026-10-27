import { Card, CardContent } from '@mastra/playground-ui/components/Card';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Txt } from '@mastra/playground-ui/components/Txt';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { MODEL_DEFAULTS_ANCHORS } from '../../../settingsSections';
import { IconTile } from './IconTile';
import { MODEL_DEFAULTS_ICONS, MODEL_DEFAULTS_LABELS, MODEL_DEFAULTS_TONES } from './model-routes';
import type { ModelDefaults } from './model-routes';

/** Every lane uses the Factory defaults, so the card is always open. */
export function DefaultsCard({
  defaults,
  anchorRef,
  model,
  providers,
}: {
  defaults: ModelDefaults;
  anchorRef: Ref<HTMLElement>;
  model: ReactNode;
  providers: ReactNode;
}) {
  const { t } = useTranslation('settings');
  return (
    <Card
      as="section"
      id={MODEL_DEFAULTS_ANCHORS[defaults]}
      aria-label={MODEL_DEFAULTS_LABELS[defaults]}
      className="scroll-mt-4"
    >
      <CardContent className="flex flex-col gap-4">
        <header ref={anchorRef} className="flex items-center gap-3">
          <IconTile icon={MODEL_DEFAULTS_ICONS[defaults]} className={MODEL_DEFAULTS_TONES[defaults]} />
          <Txt as="h3" variant="label">
            {MODEL_DEFAULTS_LABELS[defaults]}
          </Txt>
        </header>
        <Field className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2">
          <FieldLabel size="smaller" className="h-control-sm text-muted-foreground">
            {t('routing.model')}
          </FieldLabel>
          {model}
        </Field>
        <div className="flex flex-col gap-2">
          <Txt as="span" variant="caption" tone="muted">
            {t('routing.providers')}
          </Txt>
          {providers}
        </div>
      </CardContent>
    </Card>
  );
}
