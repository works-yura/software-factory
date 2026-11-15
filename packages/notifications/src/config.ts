import { EmailChannel } from './email/email-channel.ts';
import { mailTransportFromEnv, type Env } from './email/mail-config.ts';
import { consoleLog, type NotificationLog } from './log.ts';
import type { Locale, NotificationChannel } from './notification.ts';
import { Notifier, type NotificationPreferences } from './notifier.ts';

/** Built at startup; null when the channel has nothing to send with. */
export type ChannelFactory = (env: Env, log: NotificationLog) => NotificationChannel | null;

/**
 * THE place a channel is added (push, Slack, Telegram…): implement `NotificationChannel`,
 * register its factory here. `FACTORY_NOTIFY_CHANNELS` can narrow the list; every configured
 * channel is on by default.
 */
export const NOTIFICATION_CHANNELS: Readonly<Record<string, ChannelFactory>> = {
  email: (env, log) => {
    const transport = mailTransportFromEnv(env, log);
    return transport ? new EmailChannel(transport) : null;
  },
};

export interface NotifierFromEnvOptions {
  log?: NotificationLog;
  preferences?: NotificationPreferences;
  registry?: Readonly<Record<string, ChannelFactory>>;
}

const LOCALES: readonly Locale[] = ['en', 'uk'];

/** The server's Notifier, from its environment. With nothing configured it sends nothing and says so. */
export function notifierFromEnv(env: Env, options: NotifierFromEnvOptions = {}): Notifier {
  const log = options.log ?? consoleLog;
  const registry = options.registry ?? NOTIFICATION_CHANNELS;
  const wanted = env.FACTORY_NOTIFY_CHANNELS?.split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
  for (const name of wanted ?? []) {
    if (!registry[name]) throw new Error(`FACTORY_NOTIFY_CHANNELS names an unknown channel: ${name}`);
  }
  const channels: NotificationChannel[] = [];
  for (const [name, factory] of Object.entries(registry)) {
    if (wanted && !wanted.includes(name)) continue;
    const channel = factory(env, log);
    if (channel) channels.push(channel);
  }
  log.info('notifier_ready', { channels: channels.map(channel => channel.name).join(',') || 'none' });
  const locale = env.FACTORY_NOTIFY_LOCALE?.trim().toLowerCase() as Locale | undefined;
  if (locale && !LOCALES.includes(locale)) throw new Error(`FACTORY_NOTIFY_LOCALE must be one of ${LOCALES.join(', ')}.`);
  return new Notifier({
    channels,
    log,
    ...(locale ? { defaultLocale: locale } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
  });
}
