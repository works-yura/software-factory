import { Txt } from '@mastra/playground-ui/components/Txt';
import { focusRingInset } from '@mastra/playground-ui/primitives/transitions';
import { cn } from '@mastra/playground-ui/utils/cn';
import { Check } from 'lucide-react';
import { useId } from 'react';
import { onboardingSectionLabel } from '../../services/onboardingSteps';
import type { OnboardingSection } from '../../services/onboardingSteps';
import { translator } from '../../../../i18n/t';
import { ONBOARDING_FRAME_RADIUS } from './onboardingLayout';

const tk = translator('workspaces');

export interface ChangeSectionProps {
  onChange: () => void;
  changeDisabled: boolean;
}

/** A section not reached yet: a muted preview of what it asks for. */
export function OnboardingNextRow({
  section,
  index,
  hint,
}: {
  section: OnboardingSection;
  index: number;
  hint?: string;
}) {
  const label = onboardingSectionLabel(section);
  return (
    <section aria-label={label} className={cn('flex min-h-14 items-center gap-3 px-4 py-3', ONBOARDING_FRAME_RADIUS)}>
      <span
        className="bg-fill text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full"
        aria-hidden="true"
      >
        <Txt as="span" variant="meta">
          {index}
        </Txt>
      </span>
      <Txt as="span" tone="muted" className="w-20 shrink-0">
        {label}
      </Txt>
      {hint && (
        <Txt as="span" variant="meta" tone="muted" className="ms-auto truncate max-[899px]:hidden">
          {hint}
        </Txt>
      )}
    </section>
  );
}

/**
 * A finished section: a raised card, one step below the open section, whose whole row reopens it.
 * The button is named for the action; the chosen value describes it.
 */
export function OnboardingDoneRow({
  section,
  value,
  subValue,
  onChange,
  changeDisabled,
}: ChangeSectionProps & { section: OnboardingSection; value?: string; subValue?: string }) {
  const label = onboardingSectionLabel(section);
  const valueId = useId();
  return (
    <section aria-label={label} className={cn('onboarding-card bg-card', ONBOARDING_FRAME_RADIUS)}>
      <button
        type="button"
        aria-label={tk('onboarding.changeSection', { section: label.toLowerCase() })}
        aria-describedby={valueId}
        disabled={changeDisabled}
        onClick={onChange}
        className={cn(
          // No `before:` utility here: any of them gives the button a `::before` box, which the flex gap
          // then pushes the checkmark past the numbers of the other rows.
          'state-layer flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 py-3 text-start disabled:cursor-not-allowed',
          ONBOARDING_FRAME_RADIUS,
          focusRingInset,
        )}
      >
        <span
          className="bg-foreground text-background grid size-6 shrink-0 place-items-center rounded-full"
          aria-hidden="true"
        >
          <Check className="size-3.5" />
        </span>
        <Txt as="span" tone="muted" className="w-20 shrink-0">
          {label}
        </Txt>
        <span id={valueId} className="flex min-w-0 flex-1 items-baseline gap-2">
          <Txt as="span" tone="ink" className="min-w-0 truncate">
            {value}
          </Txt>
          {subValue && (
            <Txt as="span" variant="meta" tone="muted" className="shrink-0 truncate max-[899px]:hidden">
              {subValue}
            </Txt>
          )}
        </span>
        <Txt as="span" variant="caption" tone="muted" className="shrink-0">
          {tk('onboarding.change')}
        </Txt>
      </button>
    </section>
  );
}
