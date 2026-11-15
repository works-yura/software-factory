import type { Delivery, NotificationChannel, Recipient } from '../notification.ts';
import type { MailTransport } from './mail-transport.ts';

/** A plausible single address: no spaces, no angle brackets, no second `@`, no header breaks. */
const ADDRESS = /^[^\s<>@,;"'\\]+@[^\s<>@,;"'\\]+\.[^\s<>@,;"'\\]+$/;

/** Notifications as email, through one mail transport (usually a `FailoverTransport`). */
export class EmailChannel implements NotificationChannel<'email'> {
  readonly name = 'email';
  readonly format = 'email' as const;

  readonly #transport: MailTransport;

  constructor(transport: MailTransport) {
    this.#transport = transport;
  }

  address(recipient: Recipient): string | undefined {
    const email = recipient.email?.trim().toLowerCase();
    return email && ADDRESS.test(email) ? email : undefined;
  }

  async deliver({ kind, address, content }: Delivery<'email'>): Promise<void> {
    await this.#transport.deliver({ to: address, ...content, category: kind });
  }
}
