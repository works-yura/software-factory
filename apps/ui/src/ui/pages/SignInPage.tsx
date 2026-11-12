import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';

import { useApiConfig } from '../../api/config';
import { useFactoryAuth } from '../../hooks/useFactoryAuth';
import { openGoogleSignIn, redirectToLogin, signInWithGoogle } from '../domains/auth/services/auth';
import { FactoryHalftoneField } from '../domains/auth/components/FactoryHalftoneField';
import { AuthPendingSkeleton } from '../domains/auth/components/RootGuards';
import '../domains/auth/components/sign-in-page.css';
import { useTranslation } from 'react-i18next';

// Browsers can normalize backslashes into cross-origin redirects.
export function safeReturnTo(raw?: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  try {
    const resolved = new URL(raw, window.location.origin);
    if (resolved.origin !== window.location.origin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

/** better-auth deploys sign in only with Google: the button leaves for Google and comes back signed in. */
function GoogleSignInButton({ returnTo }: { returnTo: string }) {
  const { t } = useTranslation('auth');
  const { baseUrl } = useApiConfig();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    setError(null);
    setPending(true);
    try {
      openGoogleSignIn(await signInWithGoogle(baseUrl, returnTo));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.authenticationFailed'));
      setPending(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <Button variant="primary" size="lg" className="w-80 max-w-full" disabled={pending} onClick={() => void handleClick()}>
        {pending ? t('google.opening') : t('google.signIn')}
      </Button>
      {error ? (
        <Txt as="p" variant="caption" role="alert" className="text-destructive-foreground">
          {error}
        </Txt>
      ) : null}
    </div>
  );
}

export function SignInPage() {
  const { t } = useTranslation('auth');
  const { baseUrl } = useApiConfig();
  const auth = useFactoryAuth({ monitorSession: true });
  const [searchParams] = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const returnTo = safeReturnTo(searchParams.get('returnTo') ?? undefined);
  const authError = searchParams.get('error');
  const authErrorDescription = searchParams.get('error_description');
  const accessDenied = authError === 'access_denied';
  const googleSignIn = auth.data?.provider === 'better-auth';

  // A cached signed-in result may predate the redirect here. Check the cookie
  // again before sending the user back into the protected app.
  if (auth.isPending || !auth.isFetchedAfterMount) return <AuthPendingSkeleton />;

  const canReturnToApp = auth.data && (!auth.data.authEnabled || auth.data.authenticated);
  if (!auth.isFetching && !auth.isError && canReturnToApp) {
    return <Navigate to={returnTo} replace />;
  }

  return (
    <main className="bg-background text-foreground min-h-dvh">
      <div className="mx-auto grid min-h-dvh w-full max-w-7xl grid-cols-1 px-6 sm:px-10 lg:grid-cols-[minmax(380px,0.82fr)_minmax(540px,1.18fr)]">
        <section className="relative z-3 flex max-w-xl flex-col justify-center py-11 lg:py-17">
          <Txt as="h1" variant="hero" className="max-w-xl text-balance">
            {t('hero.title')}
          </Txt>
          <Txt as="p" variant="lead" tone="muted" className="mt-6 max-w-lg">
            {t('hero.lead')}
          </Txt>

          <section aria-label={t('section')} className="mt-10 w-full max-w-md lg:mt-12">
            {authError ? (
              <div role="alert" className="border-destructive-edge bg-card mb-6 rounded-lg border px-4 py-3">
                <Txt as="p" variant="subheading" className="text-destructive-foreground">
                  {accessDenied ? t('failure.accessDenied') : t('failure.signInFailed')}
                </Txt>
                {authErrorDescription || !accessDenied ? (
                  <Txt as="p" variant="caption" tone="muted" className="mt-1">
                    {authErrorDescription ?? t('failure.code', { code: authError })}
                  </Txt>
                ) : null}
                {accessDenied ? (
                  <Txt as="p" variant="caption" tone="muted" className="mt-1">
                    {t('failure.askAdmin')}
                  </Txt>
                ) : null}
              </div>
            ) : null}
            {auth.isError ? (
              <div role="alert" className="space-y-3">
                <Txt as="p" variant="body" tone="muted">
                  {t('failure.statusUnavailable')}
                </Txt>
                <Button onClick={() => void auth.refetch()} disabled={auth.isFetching}>
                  {t('failure.tryAgain')}
                </Button>
              </div>
            ) : googleSignIn ? (
              <>
                <div className="mb-6">
                  <Txt font="display" as="h2" variant="title">
                    {t('welcome.title')}
                  </Txt>
                  <Txt as="p" variant="body" tone="muted" className="mt-2">
                    {t('welcome.description')}
                  </Txt>
                </div>
                <GoogleSignInButton returnTo={returnTo} />
              </>
            ) : (
              <Button
                variant="primary"
                size="lg"
                className="w-80 max-w-full"
                disabled={redirecting || auth.isPending}
                onClick={() => {
                  setRedirecting(true);
                  redirectToLogin(baseUrl, returnTo);
                }}
              >
                {redirecting ? t('hosted.opening') : t('hosted.signIn')}
              </Button>
            )}
          </section>
        </section>

        <FactoryHalftoneField />
      </div>
    </main>
  );
}
