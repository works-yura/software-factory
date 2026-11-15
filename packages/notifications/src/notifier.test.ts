import { describe, expect, it, vi } from 'vitest';

import { silentLog, type NotificationLog } from './log.ts';
import {
  DeliveryRejectedError,
  type ContentFormat,
  type Delivery,
  type NotificationChannel,
  type NotificationTemplate,
  type Recipient,
} from './notification.ts';
import { Notifier } from './notifier.ts';

class FakeChannel<F extends ContentFormat> implements NotificationChannel<F> {
  readonly sent: Delivery<F>[] = [];
  failWith: Error | undefined;

  readonly name: string;
  readonly format: F;
  readonly #pick: (recipient: Recipient) => string | undefined;

  constructor(name: string, format: F, pick: (recipient: Recipient) => string | undefined) {
    this.name = name;
    this.format = format;
    this.#pick = pick;
  }

  address(recipient: Recipient): string | undefined {
    return this.#pick(recipient);
  }

  async deliver(delivery: Delivery<F>): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(delivery);
  }
}

const greeting: NotificationTemplate<{ name: string }> = {
  kind: 'test.greeting',
  render: {
    email: ({ name }, locale) => ({ subject: locale === 'uk' ? `Привіт, ${name}` : `Hi ${name}`, text: name, html: name }),
    short: ({ name }) => ({ title: 'Hi', body: name }),
  },
};

const emailOnly: NotificationTemplate<{ name: string }> = {
  kind: 'test.email-only',
  render: { email: ({ name }) => ({ subject: name, text: name, html: name }) },
};

function setup(log: NotificationLog = silentLog) {
  const email = new FakeChannel('email', 'email', r => r.email);
  const chat = new FakeChannel('chat', 'short', r => (r.userId ? `@${r.userId}` : undefined));
  return { email, chat, notifier: new Notifier({ channels: [email, chat], log }) };
}

describe('Notifier', () => {
  it('renders the template for each channel format and sends to every channel with an address', async () => {
    const { email, chat, notifier } = setup();

    const report = await notifier.notify(greeting, { to: { email: 'a@b.co', userId: 'u1' }, data: { name: 'Ann' } });

    expect(report).toEqual({ kind: 'test.greeting', channels: { email: 'sent', chat: 'sent' }, delivered: true });
    expect(email.sent).toEqual([{ kind: 'test.greeting', address: 'a@b.co', content: { subject: 'Hi Ann', text: 'Ann', html: 'Ann' } }]);
    expect(chat.sent[0]).toMatchObject({ address: '@u1', content: { title: 'Hi', body: 'Ann' } });
  });

  it('uses the recipient locale, else the default', async () => {
    const email = new FakeChannel('email', 'email', r => r.email);
    const notifier = new Notifier({ channels: [email], log: silentLog, defaultLocale: 'uk' });

    await notifier.notify(greeting, { to: { email: 'a@b.co' }, data: { name: 'Ann' } });
    await notifier.notify(greeting, { to: { email: 'a@b.co', locale: 'en' }, data: { name: 'Ann' } });

    expect(email.sent.map(sent => sent.content.subject)).toEqual(['Привіт, Ann', 'Hi Ann']);
  });

  it('skips a channel the template does not render, or that has no address', async () => {
    const { chat, notifier } = setup();

    expect((await notifier.notify(emailOnly, { to: { email: 'a@b.co', userId: 'u1' }, data: { name: 'x' } })).channels).toEqual({
      email: 'sent',
      chat: 'no_template',
    });
    expect((await notifier.notify(greeting, { to: { email: 'a@b.co' }, data: { name: 'x' } })).channels.chat).toBe('no_address');
    expect(chat.sent).toEqual([]);
  });

  it('sends only through the channels asked for', async () => {
    const { chat, notifier } = setup();

    const report = await notifier.notify(greeting, { to: { email: 'a@b.co', userId: 'u1' }, data: { name: 'x' }, channels: ['email'] });

    expect(report.channels).toEqual({ email: 'sent' });
    expect(chat.sent).toEqual([]);
  });

  it('never throws for a delivery problem: failures and rejections are reported', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { email, chat, notifier } = setup(log);
    email.failWith = new Error('smtp failed for ann@b.co');
    chat.failWith = new DeliveryRejectedError('chat', 'blocked');

    const report = await notifier.notify(greeting, { to: { email: 'ann@b.co', userId: 'u1' }, data: { name: 'x' } });

    expect(report).toEqual({ kind: 'test.greeting', channels: { email: 'failed', chat: 'rejected' }, delivered: false });
    expect(log.error).toHaveBeenCalledWith('notification_failed', { kind: 'test.greeting', channel: 'email', reason: 'smtp failed for [address]' });
    expect(log.warn).toHaveBeenCalledWith('notification_not_delivered', { kind: 'test.greeting', email: 'failed', chat: 'rejected' });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('ann@b.co');
  });

  it('honours preferences, except for essential templates; a broken lookup sends', async () => {
    const email = new FakeChannel('email', 'email', r => r.email);
    const preferences = { allows: vi.fn(async () => false) };
    const notifier = new Notifier({ channels: [email], log: silentLog, preferences });

    expect((await notifier.notify(greeting, { to: { email: 'a@b.co' }, data: { name: 'x' } })).channels.email).toBe('muted');
    expect(preferences.allows).toHaveBeenCalledWith({ email: 'a@b.co' }, 'test.greeting', 'email');
    expect((await notifier.notify({ ...greeting, essential: true }, { to: { email: 'a@b.co' }, data: { name: 'x' } })).delivered).toBe(true);

    preferences.allows.mockRejectedValueOnce(new Error('db down'));
    expect((await notifier.notify(greeting, { to: { email: 'a@b.co' }, data: { name: 'x' } })).delivered).toBe(true);
  });

  it('reports a notification with no channel configured as not delivered', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const report = await new Notifier({ channels: [], log }).notify(greeting, { to: { email: 'a@b.co' }, data: { name: 'x' } });

    expect(report).toEqual({ kind: 'test.greeting', channels: {}, delivered: false });
    expect(log.warn).toHaveBeenCalledWith('notification_not_delivered', { kind: 'test.greeting' });
  });

  it('refuses two channels with one name', () => {
    const one = new FakeChannel('email', 'email', () => undefined);
    expect(() => new Notifier({ channels: [one, one] })).toThrow('Two notification channels are named email.');
  });
});
