/**
 * A small model of SBPL, the Scheme-like language of Seatbelt (sandbox-exec) profiles: rules as data,
 * rendered in one place, so rule sets compose and every path is escaped the same way.
 */

export type SbplAction = 'allow' | 'deny';

export type SbplFilter =
  | { readonly kind: 'subpath' | 'literal'; readonly path: string }
  | { readonly kind: 'regex'; readonly pattern: string }
  | { readonly kind: 'global-name'; readonly name: string }
  | { readonly kind: 'remote-ip'; readonly address: string };

export interface SbplRule {
  readonly action: SbplAction;
  /** e.g. `file-read*`, `file-write*`, `network-outbound`. */
  readonly operations: readonly string[];
  /** Any of them matches; none means the operations everywhere. */
  readonly filters?: readonly SbplFilter[];
  /** e.g. `(with no-sandbox)`. */
  readonly modifier?: string;
}

/** A string as an SBPL string literal. */
export function sbplString(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${JSON.stringify(value)} cannot go in a sandbox profile.`);
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderFilter(filter: SbplFilter): string {
  switch (filter.kind) {
    case 'subpath':
    case 'literal':
      return `(${filter.kind} ${sbplString(filter.path)})`;
    case 'regex':
      if (filter.pattern.includes('"')) throw new Error(`Regex ${JSON.stringify(filter.pattern)} cannot hold a quote.`);
      return `(regex #"${filter.pattern}")`;
    case 'global-name':
      return `(global-name ${sbplString(filter.name)})`;
    case 'remote-ip':
      return `(remote ip ${sbplString(filter.address)})`;
  }
}

export function renderRule(rule: SbplRule): string {
  if (rule.operations.length === 0) throw new Error('A rule needs at least one operation.');
  const head = `(${rule.action} ${rule.operations.join(' ')}`;
  const parts = [...(rule.filters ?? []).map(renderFilter), ...(rule.modifier ? [rule.modifier] : [])];
  return parts.length === 0 ? `${head})` : `${head}\n${parts.map(part => `    ${part}`).join('\n')})`;
}

export const subpath = (path: string): SbplFilter => ({ kind: 'subpath', path });
export const literal = (path: string): SbplFilter => ({ kind: 'literal', path });
export const regex = (pattern: string): SbplFilter => ({ kind: 'regex', pattern });
export const globalName = (name: string): SbplFilter => ({ kind: 'global-name', name });
export const remoteIp = (address: string): SbplFilter => ({ kind: 'remote-ip', address });
