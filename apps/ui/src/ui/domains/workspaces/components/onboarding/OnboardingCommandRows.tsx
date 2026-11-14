import { Command, CommandList } from '@mastra/playground-ui/components/Command';
import type { ReactNode } from 'react';

import type { FactoryHarness } from '../../services/github';
import type { TurnHarness } from '../../services/turnHarness';
import { CreateFactoryTurnHarnessStep } from '../create-factory/CreateFactoryTurnHarnessStep';
import { CreateFactoryHarnessRows } from '../create-factory/CreateFactoryHarnessRows';

/**
 * The New Factory wizard's rows are command-palette rows; onboarding shows the
 * same rows in a plain list (no search field), so both flows offer one choice.
 */
function OnboardingCommandList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Command loop shouldFilter={false} label={label} className="w-full max-w-xl bg-transparent">
      <CommandList
        aria-label={label}
        className="max-h-none rounded-none border-none bg-transparent px-0 py-1 shadow-none"
      >
        {children}
      </CommandList>
    </Command>
  );
}

export function OnboardingHarnessStep({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected?: FactoryHarness;
  onSelect: (harness: FactoryHarness) => void;
}) {
  return (
    <OnboardingCommandList label={label}>
      <CreateFactoryHarnessRows selected={selected} onSelect={onSelect} />
    </OnboardingCommandList>
  );
}

/** A turn-based harness's sign-in and model (Claude Code's, Codex's), in place of the Mastra provider and model. */
export function OnboardingTurnHarnessStep({
  label,
  harness,
  selected,
  onPick,
}: {
  label: string;
  harness: TurnHarness;
  /** The model already picked (null = the harness's default); undefined when none is. */
  selected?: string | null;
  onPick: (model: string | null) => void;
}) {
  return (
    <OnboardingCommandList label={label}>
      <CreateFactoryTurnHarnessStep harness={harness} query="" selected={selected} onPick={onPick} />
    </OnboardingCommandList>
  );
}
