import type { NotificationLog } from '../log.ts';
import { FailoverTransport } from './failover-transport.ts';
import type { MailMessage, MailTransport } from './mail-transport.ts';
import { SmtpTransport } from './smtp-transport.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** Built at startup; null when the provider is not configured, so it is skipped with a warning. */
export type MailTransportFactory = (env: Env, log: NotificationLog) => MailTransport | null;

/**
 * THE place a mail provider is added: write a `MailTransport`, register it here, name it in
 * `FACTORY_MAIL_PROVIDERS` (comma-separated, the order of attempts).
 */
export const MAIL_TRANSPORTS: Readonly<Record<string, MailTransportFactory>> = {
  smtp: env => {
    const host = env.SMTP_HOST?.trim();
    const user = env.SMTP_USER?.trim();
    const pass = env.SMTP_PASS?.trim();
    if (!host || !user || !pass) return null;
    const port = Number(env.SMTP_PORT) || 465;
    return new SmtpTransport({
      host,
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE.trim().toLowerCase() === 'true' : port === 465,
      user,
      pass,
      from: env.FACTORY_MAIL_FROM?.trim() || `Factory <${user}>`,
    });
  },
  log: (_env, log) => new LogTransport(log),
};

/**
 * Development: nothing leaves the machine; the message is printed so a link in it can be opened.
 * Never in `FACTORY_MAIL_PROVIDERS` on a server that has real people's addresses in its log.
 */
export class LogTransport implements MailTransport {
  readonly name = 'log';

  readonly #log: NotificationLog;

  constructor(log: NotificationLog) {
    this.#log = log;
  }

  async deliver(message: MailMessage): Promise<void> {
    this.#log.info('mail_logged', {
      category: message.category ?? 'unknown',
      subject: message.subject,
      text: message.text,
    });
  }
}

/** `FACTORY_MAIL_PROVIDERS`, else SMTP when it is configured, else nothing (email is off). */
export function mailProviderNames(env: Env): string[] {
  const configured = env.FACTORY_MAIL_PROVIDERS?.split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
  if (configured && configured.length > 0) return configured;
  return env.SMTP_HOST?.trim() ? ['smtp'] : [];
}

/**
 * The transport email notifications go through, or null when none is configured (the email
 * channel is then absent and every report says so). A provider name nobody registered stops the
 * boot: a typo must not silently turn email off.
 */
export function mailTransportFromEnv(
  env: Env,
  log: NotificationLog,
  registry: Readonly<Record<string, MailTransportFactory>> = MAIL_TRANSPORTS,
): MailTransport | null {
  const names = mailProviderNames(env);
  const transports: MailTransport[] = [];
  for (const name of names) {
    const factory = registry[name];
    if (!factory) throw new Error(`FACTORY_MAIL_PROVIDERS names an unknown provider: ${name}`);
    const transport = factory(env, log);
    if (transport) transports.push(transport);
    else log.warn('mail_provider_skipped', { provider: name, reason: 'not configured' });
  }
  if (transports.length === 0) {
    if (names.length > 0) log.error('mail_no_provider_configured', { providers: names.join(',') });
    return null;
  }
  return transports.length === 1 ? transports[0]! : new FailoverTransport(transports, log);
}
