import { BrandLoader } from '@mastra/playground-ui/components/BrandLoader';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { FactoryWebTelemetry } from '../../telemetry/FactoryWebTelemetry';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useFactoriesQuery } from '../../../../hooks/useFactories';
import { hasResumableFactoryOnboarding } from '../../workspaces/services/onboardingFlow';
import { Navigate, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { AuthUnavailableError } from '../services/auth';
import { SessionExpiredDialog } from './SessionExpiredDialog';
import { useTranslation } from 'react-i18next';

export const RootGuards = () => {
  return (
    <>
      {/* Data routers keep the window scroll across navigations without this. */}
      <ScrollRestoration />
      <AuthGuard />
    </>
  );
};

/**
 * For pages a signed-in person opens before they have a Factory of their own, such as an
 * invitation link: the same sign-in check, without sending them to onboarding.
 */
export const SignedInOnly = () => {
  return (
    <>
      <ScrollRestoration />
      <AuthGuard onboarding={false} />
    </>
  );
};

const AuthGuard = ({ onboarding = true }: { onboarding?: boolean }) => {
  const { isPending, isError, data, error, isFetching, refetch } = useFactoryAuth({ monitorSession: true });
  const { t } = useTranslation('auth');
  const location = useLocation();
  const [wasSignedIn, setWasSignedIn] = useState(false);

  if (data?.authenticated && !wasSignedIn) setWasSignedIn(true);

  // The server could not check the session: an unavailable state, never the sign-in page.
  const unavailable = error instanceof AuthUnavailableError;
  const retry = () => void refetch();

  if (isPending) return <AuthPendingSkeleton />;
  if (unavailable && !data) return <AuthUnavailableScreen retrying={isFetching} onRetry={retry} />;
  if (isError && !data) return <AuthPendingSkeleton label={t('guards.serverUnreachable')} />;
  if (!data?.authEnabled) return <AuthNotConfiguredScreen />;

  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  if (!data.authenticated && !wasSignedIn) {
    return <Navigate to={`/signin?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  return (
    <>
      {/* Signed in, but the latest check failed on the server: keep the page (and any draft) and say so. */}
      {unavailable ? <AuthUnavailableBanner retrying={isFetching} onRetry={retry} /> : null}
      {onboarding ? <OnboardingGuard /> : <Outlet />}
      {!data.authenticated && <SessionExpiredDialog returnTo={returnTo} />}
    </>
  );
};

function AuthUnavailableScreen({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const { t } = useTranslation('auth');
  return (
    <div className="bg-sidebar grid h-dvh w-full place-items-center px-6 text-center">
      <div role="alert" className="max-w-md space-y-3">
        <Txt as="h1" variant="heading" tone="ink">
          {t('guards.unavailableTitle')}
        </Txt>
        <Txt as="p" variant="body" tone="muted">
          {t('guards.unavailableBody')}
        </Txt>
        <Button onClick={onRetry} disabled={retrying}>
          {t('guards.retry')}
        </Button>
      </div>
    </div>
  );
}

function AuthUnavailableBanner({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const { t } = useTranslation('auth');
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex justify-center p-3">
      <Notice
        variant="warning"
        role="alert"
        title={t('guards.unavailableTitle')}
        action={
          <Button size="sm" onClick={onRetry} disabled={retrying}>
            {t('guards.retry')}
          </Button>
        }
      >
        {t('guards.unavailableBody')}
      </Notice>
    </div>
  );
}

const OnboardingGuard = () => {
  const { t } = useTranslation('auth');
  const pathname = useLocation().pathname;
  const { data: factories, isPending: factoriesPending, isFetching, refetch } = useFactoriesQuery();

  if (factoriesPending) return <AuthPendingSkeleton label={t('guards.loadingFactories')} />;
  if (!factories) return <FactoriesUnavailableScreen retrying={isFetching} onRetry={() => void refetch()} />;
  if (factories.length === 0 && pathname !== '/onboarding') return <Navigate to="/onboarding" replace />;
  if (factories.length > 0 && pathname === '/onboarding' && !hasResumableFactoryOnboarding(factories)) {
    return <Navigate to={`/factories/${factories[0].id}`} replace />;
  }

  return (
    <>
      <FactoryWebTelemetry />
      <Outlet />
    </>
  );
};

function AuthNotConfiguredScreen() {
  const { t } = useTranslation('auth');
  return (
    <div className="bg-sidebar grid h-dvh w-full place-items-center px-6 text-center">
      <div className="max-w-md space-y-3">
        <Txt as="h1" variant="heading" tone="ink">
          {t('guards.notConfiguredTitle')}
        </Txt>
        <Txt as="p" variant="body" tone="muted">
          {t('guards.notConfiguredBody')}
        </Txt>
      </div>
    </div>
  );
}

function FactoriesUnavailableScreen({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const { t } = useTranslation('auth');
  return (
    <div className="bg-sidebar grid h-dvh w-full place-items-center px-6 text-center">
      <div role="alert" className="max-w-md space-y-3">
        <Txt as="h1" variant="heading" tone="ink">
          {t('guards.factoriesUnavailable')}
        </Txt>
        <Txt as="p" variant="body" tone="muted">
          {t('guards.tryAgainLater')}
        </Txt>
        <Button onClick={onRetry} disabled={retrying}>
          {t('guards.retry')}
        </Button>
      </div>
    </div>
  );
}

export function AuthPendingSkeleton({ label }: { label?: string }) {
  const { t } = useTranslation('auth');
  return (
    <div className="bg-sidebar flex h-dvh w-full items-center justify-center">
      <BrandLoader size="lg" aria-label={label ?? t('guards.checkingSignIn')} />
    </div>
  );
}
