import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { PageHeader } from '@mastra/playground-ui/components/PageHeader';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useApiConfig } from '../../api/config';
import { requestJson } from '../domains/factory/services/request';

/** Platforms whose conversation channel links accounts with a code. */
const PLATFORMS: Record<string, string> = { clickup: 'ClickUp' };

/**
 * `/connect/:platform` — the page a conversation's connect reply links to. The link names no
 * account; the signed-in member gets a one-time code and posts it from their provider account,
 * which proves the account is theirs.
 */
export function ConnectAccountPage() {
  const { t } = useTranslation('app');
  const { platform = '' } = useParams();
  const { baseUrl } = useApiConfig();
  const issue = useMutation({
    mutationFn: () =>
      requestJson<{ code: string; expiresAt: string }>(`${baseUrl}/web/channels/${encodeURIComponent(platform)}/connect-code`, {
        method: 'POST',
      }),
  });
  const name = PLATFORMS[platform];
  if (!name) return <Navigate to="/" replace />;

  return (
    <PageLayout
      variant="narrow"
      header={
        <div className="mx-auto w-full max-w-2xl pb-8">
          <PageHeader>
            <PageHeader.Title>{t('connect.title', { platform: name })}</PageHeader.Title>
          </PageHeader>
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <p>{t('connect.description', { platform: name })}</p>
        {issue.data ? (
          <>
            <p>{t('connect.instructions', { platform: name })}</p>
            <code className="rounded-md border p-3 select-all">connect {issue.data.code}</code>
            <p>{t('connect.expires', { time: new Date(issue.data.expiresAt).toLocaleTimeString() })}</p>
          </>
        ) : (
          <div>
            <Button variant="primary" onClick={() => issue.mutate()} disabled={issue.isPending}>
              {t('connect.getCode')}
            </Button>
          </div>
        )}
        {issue.error ? (
          <Notice variant="destructive" role="alert">
            {issue.error instanceof Error ? issue.error.message : String(issue.error)}
          </Notice>
        ) : null}
      </div>
    </PageLayout>
  );
}
