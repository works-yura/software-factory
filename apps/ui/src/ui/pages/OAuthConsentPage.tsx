import { BrandLoader } from '@mastra/playground-ui/components/BrandLoader';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { PageHeader } from '@mastra/playground-ui/components/PageHeader';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { useApiConfig } from '../../api/config';
import { queryKeys } from '../../api/keys';
import { useFactoryAuth } from '../../hooks/useFactoryAuth';
import {
  answerOAuthConsent,
  getOAuthClient,
  isSignedOAuthQuery,
  returnToOAuthClient,
} from '../domains/auth/services/oauth-consent';

/**
 * `/oauth/consent` — an MCP client (Claude Code, Cursor) asks to act as the signed-in person on this
 * Factory server. The OAuth provider sends the person here with its signed authorization request;
 * allowing or denying answers with that request and sends the browser back to the client.
 */
export function OAuthConsentPage() {
  const { t } = useTranslation('auth');
  const { baseUrl } = useApiConfig();
  const { search } = useLocation();
  const oauthQuery = search.startsWith('?') ? search.slice(1) : search;
  const valid = isSignedOAuthQuery(oauthQuery);
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id') ?? '';
  const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
  const email = useFactoryAuth().data?.user?.email ?? '';
  const client = useQuery({
    queryKey: queryKeys.oauthClient(clientId),
    queryFn: () => getOAuthClient(baseUrl, clientId),
    enabled: valid,
    retry: false,
  });
  const answer = useMutation({
    mutationFn: (accept: boolean) => answerOAuthConsent(baseUrl, oauthQuery, accept),
    onSuccess: url => returnToOAuthClient(url),
  });
  const name = client.data?.client_name || clientId;

  return (
    <PageLayout
      variant="narrow"
      header={
        <div className="mx-auto w-full max-w-2xl pb-8">
          <PageHeader>
            <PageHeader.Title>{t('consent.title')}</PageHeader.Title>
          </PageHeader>
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {!valid ? (
          <Notice variant="destructive" role="alert">
            {t('consent.invalid')}
          </Notice>
        ) : client.isPending ? (
          <BrandLoader size="lg" aria-label={t('consent.loading')} />
        ) : client.isError ? (
          <Notice variant="destructive" role="alert">
            {t('consent.failed', { message: client.error.message })}
          </Notice>
        ) : (
          <>
            <Txt as="p" variant="body">
              {t('consent.description', { client: name })}
            </Txt>
            <Txt as="p" variant="caption" tone="muted">
              {t('consent.signedInAs', { email })}
            </Txt>
            {scopes.length > 0 ? (
              <div className="flex flex-col gap-1">
                <Txt as="p" variant="caption" tone="muted">
                  {t('consent.scopesTitle')}
                </Txt>
                <ul aria-label={t('consent.scopesTitle')} className="list-disc pl-5">
                  {scopes.map(scope => (
                    <li key={scope}>
                      <Txt as="span" variant="body-sm">
                        {t(`consent.scopes.${scope}`, { defaultValue: scope })}
                      </Txt>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button variant="primary" disabled={answer.isPending} onClick={() => answer.mutate(true)}>
                {t('consent.allow')}
              </Button>
              <Button disabled={answer.isPending} onClick={() => answer.mutate(false)}>
                {t('consent.deny')}
              </Button>
            </div>
            {answer.isError ? (
              <Notice variant="destructive" role="alert">
                {t('consent.failed', { message: answer.error.message })}
              </Notice>
            ) : null}
          </>
        )}
      </div>
    </PageLayout>
  );
}
