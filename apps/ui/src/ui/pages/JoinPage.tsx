import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useFactoryAuth } from '../../hooks/useFactoryAuth';
import { useJoinLink } from '../../hooks/useOrganizationLinks';
import { errorText } from '../../lib/errorText';
import {
  OrganizationLinkActions,
  OrganizationLinkLoading,
  OrganizationLinkPage,
  OrganizationLinkProblem,
  OrganizationLinkSignedInAs,
} from '../domains/auth/components/OrganizationLinkPage';
import { OrganizationRequestError } from '../domains/auth/services/organization';
import type { JoinRefusal } from '../domains/auth/services/team';

const REFUSALS: readonly JoinRefusal[] = ['expired', 'revoked', 'used_up', 'domain_not_allowed', 'email_not_verified'];

/** The server's refusal codes (`join_link_<refusal>`) back to the refusal the page explains. */
function refusalOf(error: unknown): JoinRefusal | 'not_found' | undefined {
  if (!(error instanceof OrganizationRequestError) || !error.code?.startsWith('join_link_')) return undefined;
  const code = error.code.slice('join_link_'.length);
  if (code === 'not_found') return 'not_found';
  return (REFUSALS as readonly string[]).includes(code) ? (code as JoinRefusal) : undefined;
}

function JoinProblem({ refusal, error, email }: { refusal?: JoinRefusal | 'not_found'; error?: unknown; email: string }) {
  const { t } = useTranslation('auth');
  const message =
    refusal === 'not_found'
      ? t('join.notFound')
      : refusal
        ? t(`join.refusal.${refusal}`, { email })
        : t('join.failed', { message: errorText(error) });
  return (
    <OrganizationLinkProblem
      message={message}
      // Another email domain gets in only as another account: sign out to pick it.
      offerSignOut={refusal === 'domain_not_allowed'}
      signOutLabel={t('join.signOut')}
      homeLabel={t('join.goHome')}
    />
  );
}

/**
 * `/join/:token` — an organization's join link (ADR-0045). Signed-out visitors sign in first (the
 * route's guard keeps this path as `returnTo`). The page names the organization and the role;
 * joining makes it the session's active organization and opens the app afresh in it. The server
 * checks the email domain, the expiry and the use limit.
 */
export function JoinPage() {
  const { t } = useTranslation('auth');
  const { token = '' } = useParams();
  const email = useFactoryAuth().data?.user?.email ?? '';
  const { preview, accept } = useJoinLink(token);

  const details = preview.data;
  const organization = details?.organization.name ?? '';
  const title = details ? t('join.title', { organization }) : t('join.loading');

  return (
    <OrganizationLinkPage title={title}>
      {preview.isPending ? (
        <OrganizationLinkLoading label={t('join.loading')} />
      ) : preview.isError ? (
        <JoinProblem refusal={refusalOf(preview.error)} error={preview.error} email={email} />
      ) : details?.alreadyMember ? (
        <div className="flex flex-col gap-4">
          <Txt as="p" variant="body">
            {t('join.alreadyMember', { organization })}
          </Txt>
          <OrganizationLinkActions>
            <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
              {t('join.open', { organization })}
            </Button>
          </OrganizationLinkActions>
        </div>
      ) : details?.refusal ? (
        <JoinProblem refusal={details.refusal} email={email} />
      ) : details ? (
        <>
          <Txt as="p" variant="body">
            {t('join.description', { organization, role: t(`roles.${details.role}`) })}
          </Txt>
          <OrganizationLinkSignedInAs>{t('join.signedInAs', { email })}</OrganizationLinkSignedInAs>
          <OrganizationLinkActions>
            <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
              {accept.isPending ? t('join.accepting') : t('join.accept')}
            </Button>
          </OrganizationLinkActions>
          {accept.isError ? <JoinProblem refusal={refusalOf(accept.error)} error={accept.error} email={email} /> : null}
        </>
      ) : null}
    </OrganizationLinkPage>
  );
}
