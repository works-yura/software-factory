import { describe, expect, it, vi } from 'vitest';

import { silentLog } from '../log.ts';
import { DeliveryRejectedError } from '../notification.ts';
import { EmailChannel } from './email-channel.ts';
import { COOLDOWN_MS, FailoverTransport } from './failover-transport.ts';
import { LogTransport, mailProviderNames, mailTransportFromEnv } from './mail-config.ts';
import type { MailMessage, MailTransport } from './mail-transport.ts';
import { SmtpTransport } from './smtp-transport.ts';

const message: MailMessage = { to: 'ann@example.com', subject: 'S', text: 'T', html: '<p>T</p>', category: 'test.kind' };

function transport(name: string, deliver: (message: MailMessage) => Promise<void> = async () => {}): MailTransport & { deliver: ReturnType<typeof vi.fn> } {
  return { name, deliver: vi.fn(deliver) };
}

describe('SmtpTransport', () => {
  const options = { host: 'smtp.example.com', port: 465, secure: true, user: 'u@example.com', pass: 'p', from: 'Factory <u@example.com>' };

  it('sends from the configured sender with the category header', async () => {
    const sendMail = vi.fn(async () => ({}) as never);
    await new SmtpTransport({ ...options, transporter: { sendMail } }).deliver(message);

    expect(sendMail).toHaveBeenCalledWith({
      from: 'Factory <u@example.com>',
      to: 'ann@example.com',
      subject: 'S',
      text: 'T',
      html: '<p>T</p>',
      headers: { 'X-Factory-Category': 'test.kind' },
    });
  });

  it.each([
    [501, '501 bad address'],
    [553, '553 mailbox name not allowed'],
    [550, '550 5.1.1 no such user'],
  ])('rejects a refused recipient (%i)', async (responseCode, response) => {
    const sendMail = vi.fn(async () => Promise.reject(Object.assign(new Error(response), { code: 'EENVELOPE', responseCode, response })));
    await expect(new SmtpTransport({ ...options, transporter: { sendMail } }).deliver(message)).rejects.toBeInstanceOf(DeliveryRejectedError);
  });

  it('fails (not rejects) on auth, quota or network problems, without echoing the server text', async () => {
    const sendMail = vi.fn(async () =>
      Promise.reject(Object.assign(new Error('Invalid login for u@example.com'), { code: 'EAUTH', responseCode: 535 })),
    );
    const error = await new SmtpTransport({ ...options, transporter: { sendMail } }).deliver(message).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(DeliveryRejectedError);
    expect((error as Error).message).toBe('smtp failed (EAUTH, 535)');
  });
});

describe('FailoverTransport', () => {
  it('falls back to the next transport and skips a failed one during its cooldown', async () => {
    let now = 0;
    const first = transport('a', async () => Promise.reject(new Error('down')));
    const second = transport('b');
    const failover = new FailoverTransport([first, second], silentLog, () => now);

    await failover.deliver(message);
    await failover.deliver(message);
    expect(first.deliver).toHaveBeenCalledTimes(1);
    expect(second.deliver).toHaveBeenCalledTimes(2);

    now = COOLDOWN_MS;
    await failover.deliver(message);
    expect(first.deliver).toHaveBeenCalledTimes(2);
  });

  it('stops at a rejection: every provider would refuse the address', async () => {
    const first = transport('a', async () => Promise.reject(new DeliveryRejectedError('a', 'smtp 553')));
    const second = transport('b');

    await expect(new FailoverTransport([first, second], silentLog).deliver(message)).rejects.toBeInstanceOf(DeliveryRejectedError);
    expect(second.deliver).not.toHaveBeenCalled();
  });

  it('fails when every transport fails, naming them', async () => {
    const down = async () => Promise.reject(new Error('down'));
    await expect(new FailoverTransport([transport('a', down), transport('b', down)], silentLog).deliver(message)).rejects.toThrow(
      'no mail transport accepted the message (tried: a, b)',
    );
  });
});

describe('EmailChannel', () => {
  const channel = new EmailChannel(transport('t'));

  it.each([
    ['Ann@Example.com ', 'ann@example.com'],
    ['ann@example', undefined],
    ['ann@example.com\r\nBcc: x@y.z', undefined],
    ['a@b@c.d', undefined],
    [undefined, undefined],
  ])('takes a single plain address (%j)', (email, expected) => {
    expect(channel.address(email === undefined ? {} : { email })).toBe(expected);
  });

  it('passes the content and the kind to the transport', async () => {
    const t = transport('t');
    await new EmailChannel(t).deliver({ kind: 'k', address: 'a@b.co', content: { subject: 's', text: 't', html: 'h' } });
    expect(t.deliver).toHaveBeenCalledWith({ to: 'a@b.co', subject: 's', text: 't', html: 'h', category: 'k' });
  });
});

describe('mail configuration', () => {
  const smtp = { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'u@gmail.com', SMTP_PASS: 'app-password' };

  it('uses SMTP when it is configured and nothing otherwise', () => {
    expect(mailProviderNames({})).toEqual([]);
    expect(mailProviderNames(smtp)).toEqual(['smtp']);
    expect(mailProviderNames({ ...smtp, FACTORY_MAIL_PROVIDERS: ' log , SMTP ' })).toEqual(['log', 'smtp']);
  });

  it('builds one transport, or a failover over several', () => {
    expect(mailTransportFromEnv({}, silentLog)).toBeNull();
    expect(mailTransportFromEnv(smtp, silentLog)).toBeInstanceOf(SmtpTransport);
    expect(mailTransportFromEnv({ FACTORY_MAIL_PROVIDERS: 'log' }, silentLog)).toBeInstanceOf(LogTransport);
    expect(mailTransportFromEnv({ ...smtp, FACTORY_MAIL_PROVIDERS: 'smtp,log' }, silentLog)?.name).toBe('smtp>log');
  });

  it('skips a provider without its settings, and says so', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(mailTransportFromEnv({ FACTORY_MAIL_PROVIDERS: 'smtp', SMTP_HOST: 'h' }, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('mail_provider_skipped', { provider: 'smtp', reason: 'not configured' });
    expect(log.error).toHaveBeenCalledWith('mail_no_provider_configured', { providers: 'smtp' });
  });

  it('stops the boot on an unknown provider name', () => {
    expect(() => mailTransportFromEnv({ FACTORY_MAIL_PROVIDERS: 'smtpp' }, silentLog)).toThrow('unknown provider: smtpp');
  });
});
