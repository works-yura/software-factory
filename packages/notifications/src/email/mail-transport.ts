/**
 * One way of getting an email to an inbox: an SMTP server (Gmail with an app password today), an
 * email provider's API, a log line in development. Adding a provider is one class implementing
 * `MailTransport` and one entry in `MAIL_TRANSPORTS` (mail-config.ts); no feature code changes.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The template kind, for headers and provider stats. Never personal data. */
  category?: string;
}

export interface MailTransport {
  /** Short stable name for logs and `FACTORY_MAIL_PROVIDERS`. Never contains a secret. */
  readonly name: string;
  /** Resolves once the server has ACCEPTED the message; throws on anything else. */
  deliver(message: MailMessage): Promise<void>;
}
