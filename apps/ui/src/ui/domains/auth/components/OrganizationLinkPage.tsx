import { BrandLoader } from '@mastra/playground-ui/components/BrandLoader';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { PageHeader } from '@mastra/playground-ui/components/PageHeader';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { Txt } from '@mastra/playground-ui/components/Txt';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useApiConfig } from '../../../../api/config';
import { clearMastraCodeStorage, redirectToLogout } from '../services/auth';

/**
 * The page an organization link opens (`/invite/:invitationId`, `/join/:token`): a title naming the
 * organization and one narrow column under it. Shared so both read and fold the same on a phone.
 */
export function OrganizationLinkPage({ title, children }: { title: string; children: ReactNode }) {
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
      <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-6">{children}</div>
    </PageLayout>
  );
}

/** While the link is read. */
export function OrganizationLinkLoading({ label }: { label: string }) {
  return <BrandLoader size="lg" aria-label={label} />;
}

/** The link's buttons: side by side, wrapping under each other when a phone has no room for both. */
export function OrganizationLinkActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

/** "Signed in as …": an email can be longer than a phone is wide, so it breaks anywhere. */
export function OrganizationLinkSignedInAs({ children }: { children: ReactNode }) {
  return (
    <Txt as="p" variant="caption" tone="muted" className="break-all">
      {children}
    </Txt>
  );
}

/**
 * Why a link can't be used, and the way on: home always; signing out first when another account
 * (or another email domain) would get in.
 */
export function OrganizationLinkProblem({
  message,
  offerSignOut,
  signOutLabel,
  homeLabel,
}: {
  message: string;
  offerSignOut: boolean;
  signOutLabel: string;
  homeLabel: string;
}) {
  const { baseUrl } = useApiConfig();
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-4">
      <Notice variant="destructive" role="alert">
        {message}
      </Notice>
      <OrganizationLinkActions>
        {offerSignOut ? (
          <Button
            variant="primary"
            onClick={() => {
              clearMastraCodeStorage();
              redirectToLogout(baseUrl);
            }}
          >
            {signOutLabel}
          </Button>
        ) : null}
        <Button onClick={() => navigate('/')}>{homeLabel}</Button>
      </OrganizationLinkActions>
    </div>
  );
}
