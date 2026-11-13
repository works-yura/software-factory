import type { SbplRule } from './sbpl.ts';

/** A named group of rules with the reason they exist, rendered as a commented block. */
export interface ProfileSection {
  readonly title: string;
  readonly rules: readonly SbplRule[];
}
