import type { FactoryHarness } from './github';

/** The harnesses whose runs are a CLI's turns, signed in with the members' accounts (no provider step). */
export const TURN_HARNESSES = ['claude-code', 'codex'] as const satisfies readonly FactoryHarness[];

export type TurnHarness = (typeof TURN_HARNESSES)[number];

export function isTurnHarness(harness: string | null | undefined): harness is TurnHarness {
  return TURN_HARNESSES.some(turn => turn === harness);
}
