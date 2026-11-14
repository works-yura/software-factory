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
import { OrganizationRequestError, reloadIntoOrganization } from '../domains/auth/services/organization';
import { acceptJoinLink, previewJoinLink } from '../domains/auth/services/team';
import type { JoinRefusal } from '../domains/auth/services/team';

/** The server's refusal codes (`JOIN_LINK_<refusal>`) back to the refusal the page explains. */
function refusalOf(error: unknown): JoinRefusal | 'not_found' | undefined {
  if (!(error instanceof OrganizationRequestError) || !error.code?.startsWith('JOIN_LINK_')) return undefined;
  const code = error.code.slice('JOIN_LINK_'.length).toLowerCase();
  if (code === 'not_found') return 'not_found';
  return ['expired', 'revoked', 'used_up', 'domain_not_allowed', 'email_not_verified'].includes(code)
    ? (code as JoinRefusal)
    : undefined;
}

function JoinProblem({ refusal, error, email }: { refusal?: JoinRefusal | 'not_found'; error?: unknown; email: string }) {
  const { t } = useTranslation('auth');
  const { baseUrl } = useApiConfig();
  const navigate = useNavigate();
  const message =
    refusal === 'not_found'
      ? t('join.notFound')
      : refusal
        ? t(`join.refusal.${refusal}`, { email })
        : t('join.failed', { message: error instanceof Error ? error.message : String(error) });

  return (
    <div className="flex flex-col gap-4">
      <Notice variant="destructive" role="alert">
        {message}
      </Notice>
      <div className="flex gap-2">
        {refusal === 'domain_not_allowed' ? (
          <Button
            variant="primary"
            onClick={() => {
              clearMastraCodeStorage();
              redirectToLogout(baseUrl);
            }}
          >
            {t('join.signOut')}
          </Button>
        ) : null}
        <Button onClick={() => navigate('/')}>{t('join.goHome')}</Button>
      </div>
    </div>
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
  const { baseUrl } = useApiConfig();
  const auth = useFactoryAuth();
  const email = auth.data?.user?.email ?? '';
  const preview = useQuery({
    queryKey: queryKeys.joinLinkPreview(token),
    queryFn: () => previewJoinLink(baseUrl, token),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => acceptJoinLink(baseUrl, token),
    onSuccess: () => reloadIntoOrganization(),
  });

  const details = preview.data;
  const organization = details?.organization.name ?? '';
  const title = details ? t('join.title', { organization }) : t('join.loading');

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
        {preview.isPending ? (
          <BrandLoader size="lg" aria-label={t('join.loading')} />
        ) : preview.isError ? (
          <JoinProblem refusal={refusalOf(preview.error)} error={preview.error} email={email} />
        ) : details?.alreadyMember ? (
          <div className="flex flex-col gap-4">
            <Txt as="p" variant="body">
              {t('join.alreadyMember', { organization })}
            </Txt>
            <div>
              <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
                {t('join.open', { organization })}
              </Button>
            </div>
          </div>
        ) : details?.refusal ? (
          <JoinProblem refusal={details.refusal} email={email} />
        ) : details ? (
          <>
            <Txt as="p" variant="body">
              {t('join.description', { organization, role: t(`roles.${details.role}`) })}
            </Txt>
            <Txt as="p" variant="caption" tone="muted">
              {t('join.signedInAs', { email })}
            </Txt>
            <div>
              <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
                {accept.isPending ? t('join.accepting') : t('join.accept')}
              </Button>
            </div>
            {accept.isError ? <JoinProblem refusal={refusalOf(accept.error)} error={accept.error} email={email} /> : null}
          </>
        ) : null}
      </div>
    </PageLayout>
  );
}
