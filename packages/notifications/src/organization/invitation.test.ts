import { describe, expect, it, vi } from 'vitest';

import { notifierFromEnv } from '../config.ts';
import { silentLog } from '../log.ts';
import type { Delivery, NotificationChannel } from '../notification.ts';
import { Notifier } from '../notifier.ts';
import { InvitationEmails, invitationLink, invitationTemplate, type InvitationData } from './invitation.ts';

const data: InvitationData = {
  organizationName: 'Eclipt <AI>',
  inviterName: 'Vlad',
  role: 'member',
  link: 'https://factory.example.ts.net/invite/inv_1',
  expiresAt: new Date('2026-11-22T10:00:00Z'),
};

describe('invitationTemplate', () => {
  it('renders an English email with the link, the role and the expiry, escaping the HTML', () => {
    const email = invitationTemplate.render.email!(data, 'en');

    expect(email.subject).toBe('Vlad invited you to Eclipt <AI> on Factory');
    expect(email.text).toContain('as member');
    expect(email.text).toContain('22 November 2026');
    expect(email.text).toContain('Accept the invitation: https://factory.example.ts.net/invite/inv_1');
    expect(email.html).toContain('Eclipt &lt;AI&gt;');
    expect(email.html).not.toContain('Eclipt <AI>');
    expect(email.html).toContain('href="https://factory.example.ts.net/invite/inv_1"');
  });

  it('renders Ukrainian with the role name translated', () => {
    const email = invitationTemplate.render.email!(data, 'uk');
    expect(email.subject).toBe('Vlad запрошує вас до Eclipt <AI> у Factory');
    expect(email.text).toContain('«учасник»');
  });

  it('is essential, so preferences never mute it', () => {
    expect(invitationTemplate.essential).toBe(true);
  });

  it('refuses a link that is not http(s)', () => {
    expect(() => invitationTemplate.render.email!({ ...data, link: 'javascript:alert(1)' }, 'en')).toThrow('Refusing a javascript: link');
  });
});

describe('invitationLink', () => {
  it('points at the UI invite page on the public origin, encoding the id', () => {
    expect(invitationLink('https://factory.example.ts.net', 'a/b')).toBe('https://factory.example.ts.net/invite/a%2Fb');
    expect(invitationLink('https://factory.example.ts.net/', 'x')).toBe('https://factory.example.ts.net/invite/x');
  });
});

describe('InvitationEmails', () => {
  it('emails the invited address with the invitation link', async () => {
    const sent: Delivery<'email'>[] = [];
    const channel: NotificationChannel<'email'> = {
      name: 'email',
      format: 'email',
      address: recipient => recipient.email,
      deliver: async delivery => void sent.push(delivery),
    };
    const emails = new InvitationEmails(new Notifier({ channels: [channel], log: silentLog }), 'https://factory.example.ts.net');

    await emails.invitationCreated({
      invitationId: 'inv_1',
      email: 'new@example.com',
      role: 'admin',
      organization: { id: 'org_1', name: 'Eclipt' },
      inviter: { userId: 'u1', email: 'vlad@example.com' },
      expiresAt: new Date('2026-11-22T10:00:00Z'),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.address).toBe('new@example.com');
    expect(sent[0]!.kind).toBe('organization.invitation');
    expect(sent[0]!.content.subject).toBe('vlad@example.com invited you to Eclipt on Factory');
    expect(sent[0]!.content.text).toContain('https://factory.example.ts.net/invite/inv_1');
  });

  it('resolves even when the mail server is down', async () => {
    const channel: NotificationChannel<'email'> = {
      name: 'email',
      format: 'email',
      address: recipient => recipient.email,
      deliver: vi.fn(async () => Promise.reject(new Error('down'))),
    };
    const emails = new InvitationEmails(new Notifier({ channels: [channel], log: silentLog }), 'https://f.example');

    await expect(
      emails.invitationCreated({
        invitationId: 'i',
        email: 'a@b.co',
        role: 'member',
        organization: { id: 'o', name: 'O' },
        inviter: { userId: 'u' },
        expiresAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('notifierFromEnv', () => {
  it('has the email channel only when a mail provider is configured', () => {
    expect(notifierFromEnv({}, { log: silentLog }).channels).toEqual([]);
    expect(notifierFromEnv({ FACTORY_MAIL_PROVIDERS: 'log' }, { log: silentLog }).channels).toEqual(['email']);
    expect(notifierFromEnv({ FACTORY_MAIL_PROVIDERS: 'log', FACTORY_NOTIFY_CHANNELS: 'email' }, { log: silentLog }).channels).toEqual(['email']);
  });

  it('stops the boot on an unknown channel or locale', () => {
    expect(() => notifierFromEnv({ FACTORY_NOTIFY_CHANNELS: 'pager' }, { log: silentLog })).toThrow('unknown channel: pager');
    expect(() => notifierFromEnv({ FACTORY_NOTIFY_LOCALE: 'de' }, { log: silentLog })).toThrow('FACTORY_NOTIFY_LOCALE');
  });
});
