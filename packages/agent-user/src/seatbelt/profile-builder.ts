import type { ProfileSection } from './profile-section.ts';
import { renderRule } from './sbpl.ts';

/**
 * Builds an SBPL profile from sections in order. Order is meaning: Seatbelt applies the last rule
 * that matches, so a section that re-allows must come after the one that denies.
 */
export class SbplProfileBuilder {
  readonly #header: string[];
  readonly #sections: ProfileSection[] = [];
  #defaultAction: 'allow' | 'deny' = 'allow';

  constructor(header: string | readonly string[] = []) {
    this.#header = typeof header === 'string' ? [header] : [...header];
  }

  /** What happens to an operation no rule matches. */
  byDefault(action: 'allow' | 'deny'): this {
    this.#defaultAction = action;
    return this;
  }

  section(section: ProfileSection): this {
    if (section.rules.length > 0) this.#sections.push(section);
    return this;
  }

  build(): string {
    const header = this.#header.map(line => `;; ${line}`);
    const body = this.#sections.map(({ title, rules }) => [`;; ${title}`, ...rules.map(renderRule)].join('\n'));
    return [...header, '(version 1)', `(${this.#defaultAction} default)`, ...body].join('\n\n').concat('\n');
  }
}
