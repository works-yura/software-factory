import { scrubReason, type NotificationLog } from '../log.ts';
import { DeliveryRejectedError } from '../notification.ts';
import type { MailMessage, MailTransport } from './mail-transport.ts';

/** How long a transport that just failed is skipped, so an outage costs one slow attempt per window. */
export const COOLDOWN_MS = 30_000;

/**
 * Sends through the first transport that accepts the message; on failure, the next. A rejection
 * (a bad address) stops here: every provider would refuse it. If every transport is cooling down,
 * all are tried anyway. A message can arrive twice when a provider accepted it but its answer was
 * lost; for the messages Factory sends (links) that is harmless.
 */
export class FailoverTransport implements MailTransport {
  readonly name: string;
  readonly #failedAt = new Map<string, number>();
  readonly #transports: readonly MailTransport[];
  readonly #log: NotificationLog;
  readonly #now: () => number;

  constructor(transports: readonly MailTransport[], log: NotificationLog, now: () => number = Date.now) {
    if (transports.length === 0) throw new Error('FailoverTransport needs at least one transport.');
    this.#transports = transports;
    this.#log = log;
    this.#now = now;
    this.name = transports.map(transport => transport.name).join('>');
  }

  async deliver(message: MailMessage): Promise<void> {
    const attempted: string[] = [];
    for (const transport of this.#order()) {
      attempted.push(transport.name);
      try {
        await transport.deliver(message);
        this.#failedAt.delete(transport.name);
        if (attempted.length > 1) this.#log.warn('mail_sent_by_fallback', { transport: transport.name });
        return;
      } catch (error) {
        if (error instanceof DeliveryRejectedError) throw error;
        this.#failedAt.set(transport.name, this.#now());
        this.#log.error('mail_transport_failed', { transport: transport.name, reason: scrubReason(error) });
      }
    }
    throw new Error(`no mail transport accepted the message (tried: ${attempted.join(', ')})`);
  }

  #order(): readonly MailTransport[] {
    const now = this.#now();
    const ready = this.#transports.filter(transport => {
      const failed = this.#failedAt.get(transport.name);
      return failed === undefined || now - failed >= COOLDOWN_MS;
    });
    return ready.length > 0 ? ready : this.#transports;
  }
}
