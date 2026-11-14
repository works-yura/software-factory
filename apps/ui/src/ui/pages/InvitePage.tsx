import { BrandLoader } from '@mastra/playground-ui/components/BrandLoader';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { PageHeader } from '@mastra/playground-ui/components/PageHeader';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { useApiConfig } from '../../api/config';
import { queryKeys } from '../../api/keys';
import { useFactoryAuth } from '../../hooks/useFactoryAuth';
import { clearMastraCodeStorage, redirectToLogout } from '../domains/auth/services/auth';
import {
  acceptInvitation,
  getInvitation,
  OrganizationRequestError,
  reloadIntoOrganization,
  rejectInvitation,
} from '../domains/auth/services/organization';

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
  const { baseUrl } = useApiConfig();
  const navigate = useNavigate();
  const kind = invitationProblemKind(error);
  const wrongEmail = kind === 'wrongEmail';
  const notFound = kind === 'notFound';
  const message = wrongEmail
    ? t('invite.wrongEmail', { email })
    : notFound
      ? t('invite.notFound')
      : t('invite.failed', { message: error instanceof Error ? error.message : String(error) });

  return (
    <div className="flex flex-col gap-4">
      <Notice variant="destructive" role="alert">
        {message}
      </Notice>
      <div className="flex gap-2">
        {wrongEmail ? (
          <Button
            variant="primary"
            onClick={() => {
              clearMastraCodeStorage();
              redirectToLogout(baseUrl);
            }}
          >
            {t('invite.signOut')}
          </Button>
        ) : null}
        <Button onClick={() => navigate('/')}>{t('invite.goHome')}</Button>
      </div>
    </div>
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
  const { baseUrl } = useApiConfig();
  const navigate = useNavigate();
  const auth = useFactoryAuth();
  const email = auth.data?.user?.email ?? '';
  const invitation = useQuery({
    queryKey: queryKeys.invitation(invitationId),
    queryFn: () => getInvitation(baseUrl, invitationId),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => acceptInvitation(baseUrl, invitationId),
    onSuccess: () => reloadIntoOrganization(),
  });
  const decline = useMutation({ mutationFn: () => rejectInvitation(baseUrl, invitationId) });

  const details = invitation.data;
  const title = details ? t('invite.title', { organization: details.organizationName }) : t('invite.loading');

  return (
    <PageLayout
      variant="narrow"
      header={
        <div className="mx-auto w-full max-w-2xl pb-8">
          <PageHeader>
            <PageHeader.Title>{title}</PageHeader.Title>
          </PageHeader>
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {invitation.isPending ? (
          <BrandLoader size="lg" aria-label={t('invite.loading')} />
        ) : invitation.isError ? (
          <InvitationProblem error={invitation.error} email={email} />
        ) : decline.isSuccess ? (
          <div className="flex flex-col gap-4">
            <Txt as="p" variant="body">
              {t('invite.declined')}
            </Txt>
            <div>
              <Button onClick={() => navigate('/')}>{t('invite.goHome')}</Button>
            </div>
          </div>
        ) : details ? (
          <>
            <Txt as="p" variant="body">
              {t('invite.description', {
                inviter: details.inviterEmail,
                organization: details.organizationName,
                role: t(`roles.${details.role === 'owner' ? 'admin' : details.role}`),
              })}
            </Txt>
            <Txt as="p" variant="caption" tone="muted">
              {t('invite.signedInAs', { email })}
            </Txt>
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={accept.isPending || decline.isPending}
                onClick={() => accept.mutate()}
              >
                {accept.isPending ? t('invite.accepting') : t('invite.accept')}
              </Button>
              <Button disabled={accept.isPending || decline.isPending} onClick={() => decline.mutate()}>
                {t('invite.decline')}
              </Button>
            </div>
            {accept.isError || decline.isError ? (
              <InvitationProblem error={accept.error ?? decline.error} email={email} />
            ) : null}
          </>
        ) : null}
      </div>
    </PageLayout>
  );
}
