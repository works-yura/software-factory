import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const CONNECT_CODE_TTL_MS = 30 * 60_000;
/** `connect FCT-AB12CD` anywhere in a message redeems the code. */
const CODE_PATTERN = /\bconnect\s+(FCT-[A-Z0-9]{6})\b/i;

export interface ConnectCodeOwner {
  userId: string;
  orgId: string;
}

/**
 * One-time codes that prove a provider account belongs to a Factory member: the member gets a
 * code while signed in to Factory and posts it from the provider account. The connect link in a
 * thread carries no identity, so posting it publicly is safe. Codes live in memory: a restart
 * only means asking for a new one.
 */
export class ConnectCodes {
  readonly #codes = new Map<string, ConnectCodeOwner & { platform: string; expiresAt: number }>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  issue(platform: string, owner: ConnectCodeOwner): { code: string; expiresAt: string } {
    this.#sweep();
    let code = '';
    do {
      code = `FCT-${Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
    } while (this.#codes.has(code));
    const expiresAt = this.#now() + CONNECT_CODE_TTL_MS;
    this.#codes.set(code, { ...owner, platform, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The code a message carries, if any (whether or not it is valid). */
  static find(text: string): string | null {
    return CODE_PATTERN.exec(text)?.[1]?.toUpperCase() ?? null;
  }

  /** Consumes a valid code for `platform`; `null` for an unknown, expired or other-platform code. */
  redeem(platform: string, code: string): ConnectCodeOwner | null {
    this.#sweep();
    const entry = this.#codes.get(code.toUpperCase());
    if (!entry || entry.platform !== platform) return null;
    this.#codes.delete(code.toUpperCase());
    return { userId: entry.userId, orgId: entry.orgId };
  }

  #sweep(): void {
    const now = this.#now();
    for (const [code, entry] of this.#codes) if (entry.expiresAt <= now) this.#codes.delete(code);
  }
}
