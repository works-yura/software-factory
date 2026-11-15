/**
 * The invitation to an organization: an email with the same `/invite/:id` link the team settings
 * show, and a short form for push and chat channels. Essential: the person was invited by name and
 * has no preferences yet.
 */

import type { InvitationCreated, InvitationNotifier } from '@factory/access';

import { renderEmailHtml } from '../html.ts';
import type { Locale, NotificationTemplate } from '../notification.ts';
import type { Notifier } from '../notifier.ts';

export interface InvitationData {
  organizationName: string;
  inviterName: string;
  role: string;
  link: string;
  expiresAt: Date;
}

const ROLES: Record<Locale, Record<string, string>> = {
  en: { viewer: 'viewer', member: 'member', admin: 'admin' },
  uk: { viewer: 'глядач', member: 'учасник', admin: 'адміністратор' },
};

const COPY = {
  en: {
    subject: (d: InvitationData) => `${d.inviterName} invited you to ${d.organizationName} on Factory`,
    heading: (d: InvitationData) => `Join ${d.organizationName} on Factory`,
    body: (d: InvitationData, role: string) =>
      `${d.inviterName} invited you to the organization ${d.organizationName} as ${role}.`,
    signIn: 'Open the link and sign in with Google using this email address.',
    expires: (date: string) => `The invitation is valid until ${date}.`,
    action: 'Accept the invitation',
    footer: 'If you did not expect this invitation, ignore this email.',
  },
  uk: {
    subject: (d: InvitationData) => `${d.inviterName} запрошує вас до ${d.organizationName} у Factory`,
    heading: (d: InvitationData) => `Приєднуйтеся до ${d.organizationName} у Factory`,
    body: (d: InvitationData, role: string) =>
      `${d.inviterName} запрошує вас до організації ${d.organizationName} з роллю «${role}».`,
    signIn: 'Відкрийте посилання й увійдіть через Google з цією адресою пошти.',
    expires: (date: string) => `Запрошення дійсне до ${date}.`,
    action: 'Прийняти запрошення',
    footer: 'Якщо ви не чекали цього запрошення, просто проігноруйте лист.',
  },
} satisfies Record<Locale, unknown>;

function formatDate(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'uk' ? 'uk-UA' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

export const invitationTemplate: NotificationTemplate<InvitationData> = {
  kind: 'organization.invitation',
  essential: true,
  render: {
    email: (data, locale) => {
      const copy = COPY[locale];
      const role = ROLES[locale][data.role] ?? data.role;
      const paragraphs = [copy.body(data, role), copy.signIn, copy.expires(formatDate(data.expiresAt, locale))];
      return {
        subject: copy.subject(data),
        text: [...paragraphs, '', `${copy.action}: ${data.link}`, '', copy.footer].join('\n'),
        html: renderEmailHtml({
          heading: copy.heading(data),
          paragraphs,
          action: { label: copy.action, url: data.link },
          footer: copy.footer,
        }),
      };
    },
    short: (data, locale) => ({ title: COPY[locale].heading(data), body: COPY[locale].body(data, ROLES[locale][data.role] ?? data.role), url: data.link }),
  },
};

/** The link the invited person opens (the UI's `/invite/:invitationId`). */
export function invitationLink(publicUrl: string, invitationId: string): string {
  return new URL(`/invite/${encodeURIComponent(invitationId)}`, publicUrl).toString();
}

/** `InvitationNotifier` for the auth provider: every created or re-sent invitation goes out. */
export class InvitationEmails implements InvitationNotifier {
  readonly #notifier: Notifier;
  readonly #publicUrl: string;

  constructor(notifier: Notifier, publicUrl: string) {
    this.#notifier = notifier;
    this.#publicUrl = publicUrl;
  }

  async invitationCreated(event: InvitationCreated): Promise<void> {
    await this.#notifier.notify(invitationTemplate, {
      to: { email: event.email },
      data: {
        organizationName: event.organization.name,
        inviterName: event.inviter.name?.trim() || event.inviter.email || 'Factory',
        role: event.role,
        link: invitationLink(this.#publicUrl, event.invitationId),
        expiresAt: event.expiresAt,
      },
    });
  }
}
