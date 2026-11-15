/**
 * The single funnel for notifications: feature code says what happened and to whom; the Notifier
 * decides which channels carry it, renders the template for each channel's format, and reports
 * what every channel did. It never throws for a delivery problem: the event already happened (an
 * invitation exists, a card waits), and a mail server being down must not undo it.
 */

import { consoleLog, scrubReason, type NotificationLog } from './log.ts';
import {
  DeliveryRejectedError,
  type ChannelOutcome,
  type ContentFormat,
  type Locale,
  type NotificationChannel,
  type NotificationReport,
  type NotificationTemplate,
  type Recipient,
} from './notification.ts';

/** Whether a recipient wants a kind of notification on a channel. Essential templates skip it. */
export interface NotificationPreferences {
  allows(recipient: Recipient, kind: string, channel: string): Promise<boolean>;
}

/** Until people can mute anything, everything is on. */
export const everythingOn: NotificationPreferences = { allows: async () => true };

export interface NotifierOptions {
  channels: readonly NotificationChannel[];
  preferences?: NotificationPreferences;
  /** For a recipient with no locale of their own. */
  defaultLocale?: Locale;
  log?: NotificationLog;
}

export interface Notify<D> {
  to: Recipient;
  data: D;
  /** Only these channels (by name); all of them when left out. */
  channels?: readonly string[];
}

export class Notifier {
  readonly #channels: readonly NotificationChannel[];
  readonly #preferences: NotificationPreferences;
  readonly #locale: Locale;
  readonly #log: NotificationLog;

  constructor(options: NotifierOptions) {
    const names = options.channels.map(channel => channel.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) throw new Error(`Two notification channels are named ${duplicate}.`);
    this.#channels = options.channels;
    this.#preferences = options.preferences ?? everythingOn;
    this.#locale = options.defaultLocale ?? 'en';
    this.#log = options.log ?? consoleLog;
  }

  /** The names of the channels this Notifier sends through, for status pages and the UI. */
  get channels(): string[] {
    return this.#channels.map(channel => channel.name);
  }

  async notify<D>(template: NotificationTemplate<D>, request: Notify<D>): Promise<NotificationReport> {
    const selected = request.channels
      ? this.#channels.filter(channel => request.channels!.includes(channel.name))
      : this.#channels;
    const outcomes = await Promise.all(selected.map(channel => this.#send(channel, template, request)));
    const channels = Object.fromEntries(selected.map((channel, index) => [channel.name, outcomes[index]!]));
    const delivered = outcomes.includes('sent');
    // Muted everywhere is the recipient's choice; anything else that reached nobody is worth a line.
    const unwanted = outcomes.length > 0 && outcomes.every(outcome => outcome === 'muted' || outcome === 'no_template');
    if (!delivered && !unwanted) this.#log.warn('notification_not_delivered', { kind: template.kind, ...channels });
    return { kind: template.kind, channels, delivered };
  }

  async #send<D, F extends ContentFormat>(
    channel: NotificationChannel<F>,
    template: NotificationTemplate<D>,
    { to, data }: Notify<D>,
  ): Promise<ChannelOutcome> {
    const render = template.render[channel.format];
    if (!render) return 'no_template';
    const address = channel.address(to);
    if (!address) return 'no_address';
    if (!template.essential && !(await this.#allows(to, template.kind, channel.name))) return 'muted';
    try {
      await channel.deliver({ kind: template.kind, address, content: render(data, to.locale ?? this.#locale) });
      this.#log.info('notification_sent', { kind: template.kind, channel: channel.name });
      return 'sent';
    } catch (error) {
      const rejected = error instanceof DeliveryRejectedError;
      this.#log.error(rejected ? 'notification_rejected' : 'notification_failed', {
        kind: template.kind,
        channel: channel.name,
        reason: scrubReason(error),
      });
      return rejected ? 'rejected' : 'failed';
    }
  }

  /** A failed preferences lookup sends: a missed mute is better than a missed invitation. */
  async #allows(to: Recipient, kind: string, channel: string): Promise<boolean> {
    try {
      return await this.#preferences.allows(to, kind, channel);
    } catch (error) {
      this.#log.warn('notification_preferences_failed', { kind, channel, reason: scrubReason(error) });
      return true;
    }
  }
}
