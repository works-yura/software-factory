import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { useFactoryAuth } from '../../hooks/useFactoryAuth';
import { useInvitation } from '../../hooks/useOrganizationLinks';
import { errorText } from '../../lib/errorText';
import {
  OrganizationLinkActions,
  OrganizationLinkLoading,
  OrganizationLinkPage,
  OrganizationLinkProblem,
  OrganizationLinkSignedInAs,
} from '../domains/auth/components/OrganizationLinkPage';
import { OrganizationRequestError } from '../domains/auth/services/organization';

/** better-auth error codes that mean "signed in with another (or an unverified) email". */
const WRONG_EMAIL_CODES = new Set([
  'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
  'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION',
  'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
]);

/** Expired, cancelled or already used: what `accept-invitation` and `reject-invitation` answer. */
const NOT_FOUND_CODE = 'INVITATION_NOT_FOUND';

type InvitationProblemKind = 'wrongEmail' | 'notFound' | 'other';

/**
 * Reads better-auth's error code. `get-invitation` alone answers a missing or expired invitation
 * with a code-less 400 ("Invitation not found!"), so a 400 without a code is the last resort for
 * "not found"; any other status or unknown code is shown as it is.
 */
function invitationProblemKind(error: unknown): InvitationProblemKind {
  if (!(error instanceof OrganizationRequestError)) return 'other';
  if (error.code && WRONG_EMAIL_CODES.has(error.code)) return 'wrongEmail';
  if (error.code === NOT_FOUND_CODE) return 'notFound';
  if (!error.code && error.status === 400) return 'notFound';
  return 'other';
}

function InvitationProblem({ error, email }: { error: unknown; email: string }) {
  const { t } = useTranslation('auth');
  const kind = invitationProblemKind(error);
  const message =
    kind === 'wrongEmail'
      ? t('invite.wrongEmail', { email })
      : kind === 'notFound'
        ? t('invite.notFound')
        : t('invite.failed', { message: errorText(error) });
  return (
    <OrganizationLinkProblem
      message={message}
      offerSignOut={kind === 'wrongEmail'}
      signOutLabel={t('invite.signOut')}
      homeLabel={t('invite.goHome')}
    />
  );
}

/**
 * `/invite/:invitationId` — the link an owner or admin copied and sent. Signed-out visitors are
 * sent to sign in first (the route's guard keeps this path as `returnTo`). Accepting joins the
 * organization with the invitation's role; better-auth makes it the session's active organization in the same
 * call, and the app opens afresh in it.
 */
export function InvitePage() {
  const { t } = useTranslation('auth');
  const { invitationId = '' } = useParams();
  const navigate = useNavigate();
  const email = useFactoryAuth().data?.user?.email ?? '';
  const { invitation, accept, decline } = useInvitation(invitationId);

  const details = invitation.data;
  const title = details ? t('invite.title', { organization: details.organizationName }) : t('invite.loading');
  const busy = accept.isPending || decline.isPending;

  return (
    <OrganizationLinkPage title={title}>
      {invitation.isPending ? (
        <OrganizationLinkLoading label={t('invite.loading')} />
      ) : invitation.isError ? (
        <InvitationProblem error={invitation.error} email={email} />
      ) : decline.isSuccess ? (
        <div className="flex flex-col gap-4">
          <Txt as="p" variant="body">
            {t('invite.declined')}
          </Txt>
          <OrganizationLinkActions>
            <Button onClick={() => navigate('/')}>{t('invite.goHome')}</Button>
          </OrganizationLinkActions>
        </div>
      ) : details ? (
        <>
          <Txt as="p" variant="body" className="break-words">
            {t('invite.description', {
              inviter: details.inviterEmail,
              organization: details.organizationName,
              role: t(`roles.${details.role === 'owner' ? 'admin' : details.role}`),
            })}
          </Txt>
          <OrganizationLinkSignedInAs>{t('invite.signedInAs', { email })}</OrganizationLinkSignedInAs>
          <OrganizationLinkActions>
            <Button variant="primary" disabled={busy} onClick={() => accept.mutate()}>
              {accept.isPending ? t('invite.accepting') : t('invite.accept')}
            </Button>
            <Button disabled={busy} onClick={() => decline.mutate()}>
              {t('invite.decline')}
            </Button>
          </OrganizationLinkActions>
          {accept.isError || decline.isError ? (
            <InvitationProblem error={accept.error ?? decline.error} email={email} />
          ) : null}
        </>
      ) : null}
    </OrganizationLinkPage>
  );
}
