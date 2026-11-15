import { createTransport, type Transporter } from 'nodemailer';

import { DeliveryRejectedError } from '../notification.ts';
import type { MailMessage, MailTransport } from './mail-transport.ts';

const TIMEOUT_MS = 10_000;

export interface SmtpOptions {
  host: string;
  port: number;
  /** true: TLS from the first byte (port 465); false: STARTTLS upgrade (port 587). */
  secure: boolean;
  user: string;
  pass: string;
  /** `Name <address>`. Gmail rewrites any other address to the account's own. */
  from: string;
  timeoutMs?: number;
  /** For tests. */
  transporter?: Pick<Transporter, 'sendMail'>;
}

/**
 * Any SMTP server (Gmail: smtp.gmail.com:465 with an app password, about 500 messages a day).
 *
 * Only a refused RECIPIENT (SMTP 501/553, or 550 with an enhanced code 5.1.x: "no such user") is
 * a rejection: another provider would refuse it too. Bad credentials, a daily quota (Gmail answers
 * 550 5.4.5), a timeout or no network are failures, and the next transport gets a try.
 */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  readonly #from: string;
  readonly #transporter: Pick<Transporter, 'sendMail'>;

  constructor(options: SmtpOptions) {
    const timeout = options.timeoutMs ?? TIMEOUT_MS;
    this.#from = options.from;
    this.#transporter =
      options.transporter ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: { user: options.user, pass: options.pass },
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
      });
  }

  async deliver(message: MailMessage): Promise<void> {
    try {
      await this.#transporter.sendMail({
        from: this.#from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.category ? { headers: { 'X-Factory-Category': message.category } } : {}),
      });
    } catch (error) {
      const e = error as { code?: string; responseCode?: number; response?: string };
      if (e.code === 'EENVELOPE' && isBadRecipient(e.responseCode, e.response)) {
        throw new DeliveryRejectedError(this.name, `smtp ${e.responseCode ?? 0}`);
      }
      // The error text can echo the address or the credentials' user; only the codes go on.
      throw new Error(`smtp failed (${e.code ?? 'unknown'}, ${e.responseCode ?? 'no response'})`);
    }
  }
}

function isBadRecipient(responseCode?: number, response?: string): boolean {
  if (responseCode === 501 || responseCode === 553) return true;
  return responseCode === 550 && /\b5\.1\.\d+\b/.test(response ?? '');
}
