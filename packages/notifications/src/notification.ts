/**
 * The vocabulary every channel shares. A notification is a template (what happened, rendered per
 * content format) plus the data for one occurrence, sent to one recipient. A channel (email,
 * push, Slack, Telegram…) consumes one content format and knows how to find its own address for
 * a recipient. Adding a channel never touches a template that already renders its format; adding
 * a template never touches a channel.
 */

export type Locale = 'en' | 'uk';

/** Who a notification is for. Each channel picks the address it can use; none is required. */
export interface Recipient {
  /** The Factory user, when the recipient has one (preferences, push devices, chat handles). */
  userId?: string;
  email?: string;
  name?: string;
  locale?: Locale;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** A short line and an optional link: what push notifications and chat messages show. */
export interface ShortContent {
  title: string;
  body: string;
  url?: string;
}

/**
 * Every content format a template can render and a channel can consume. A new format (rich
 * Slack blocks, say) is one more key here: templates that skip it are simply not sent there.
 */
export interface ContentFormats {
  email: EmailContent;
  short: ShortContent;
}

export type ContentFormat = keyof ContentFormats;

export type Renderers<D> = { [F in ContentFormat]?: (data: D, locale: Locale) => ContentFormats[F] };

export interface NotificationTemplate<D> {
  /** Stable id for logs, preferences and deduplication (`organization.invitation`). Never personal data. */
  readonly kind: string;
  /**
   * The recipient asked for this exact message or cannot do without it (an invitation, a sign-in
   * link): preferences do not mute it.
   */
  readonly essential?: boolean;
  readonly render: Renderers<D>;
}

/** One way of reaching a person. Implementations: `EmailChannel`; push and messengers to come. */
export interface NotificationChannel<F extends ContentFormat = ContentFormat> {
  /** Short stable name for logs, preferences and `channels` filters. Never a secret. */
  readonly name: string;
  readonly format: F;
  /** The address this channel would use for the recipient, or undefined when it has none. */
  address(recipient: Recipient): string | undefined;
  /** Resolves once the provider has accepted the message; throws otherwise. */
  deliver(delivery: Delivery<F>): Promise<void>;
}

export interface Delivery<F extends ContentFormat> {
  kind: string;
  address: string;
  content: ContentFormats[F];
}

/** A provider refused this address or message; retrying elsewhere would not help. */
export class DeliveryRejectedError extends Error {
  readonly channel: string;
  readonly reason: string;

  constructor(channel: string, reason: string) {
    super(`${channel} rejected the message (${reason})`);
    this.channel = channel;
    this.reason = reason;
    this.name = 'DeliveryRejectedError';
  }
}

/**
 * What happened on one channel:
 * - `sent`: the provider accepted it;
 * - `muted`: the recipient's preferences turned it off;
 * - `no_address`: the channel has no address for the recipient;
 * - `no_template`: the template does not render the channel's format;
 * - `rejected`: the provider refused this message or address;
 * - `failed`: the provider was unreachable, misconfigured or out of quota.
 */
export type ChannelOutcome = 'sent' | 'muted' | 'no_address' | 'no_template' | 'rejected' | 'failed';

export interface NotificationReport {
  kind: string;
  channels: Record<string, ChannelOutcome>;
  /** True when at least one channel accepted the message. */
  delivered: boolean;
}
