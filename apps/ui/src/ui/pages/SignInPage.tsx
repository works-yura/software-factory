import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Form } from '@mastra/playground-ui/components/Form';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';

import { useApiConfig } from '../../api/config';
import { useFactoryAuth } from '../../hooks/useFactoryAuth';
import {
  navigateAfterSignIn,
  redirectToLogin,
  signInWithPassword,
  signUpWithPassword,
} from '../domains/auth/services/auth';
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

function CredentialSignInForm({ returnTo, signUpDisabled }: { returnTo: string; signUpDisabled: boolean }) {
  const { t } = useTranslation('auth');
  const { baseUrl } = useApiConfig();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (mode === 'sign-up') {
        await signUpWithPassword(baseUrl, { name, email, password });
      } else {
        await signInWithPassword(baseUrl, { email, password });
      }
      navigateAfterSignIn(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.authenticationFailed'));
      setPending(false);
    }
  };

  return (
    <Form onSubmit={handleSubmit} className="w-full gap-5">
      {mode === 'sign-up' ? (
        <Field>
          <FieldLabel>{t('form.name')}</FieldLabel>
          <Input
            type="text"
            size="lg"
            placeholder="Ada Lovelace"
            autoComplete="name"
            required
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <FieldError />
        </Field>
      ) : null}
      <Field>
        <FieldLabel>{t('form.email')}</FieldLabel>
        <Input
          type="email"
          size="lg"
          placeholder="you@company.com"
          autoComplete="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <FieldError />
      </Field>
      <Field>
        <FieldLabel>{t('form.password')}</FieldLabel>
        <Input
          type="password"
          size="lg"
          placeholder={t('form.passwordPlaceholder')}
          autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
          required
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        <FieldError />
      </Field>
      {error ? (
        <Txt as="p" variant="caption" role="alert" className="text-destructive-foreground">
          {error}
        </Txt>
      ) : null}
      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
        {pending ? t('form.pending') : mode === 'sign-up' ? t('form.createAccount') : t('form.signIn')}
      </Button>
      {!signUpDisabled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-center"
          onClick={() => {
            setError(null);
            setMode(mode === 'sign-up' ? 'sign-in' : 'sign-up');
          }}
        >
          {mode === 'sign-up' ? t('form.haveAccount') : t('form.newHere')}
        </Button>
      ) : (
        <Txt as="p" variant="caption" tone="muted" className="text-center">
          {t('form.signUpDisabled')}
        </Txt>
      )}
    </Form>
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
  const credentialForm = auth.data?.provider === 'better-auth';

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
                {authErrorDescription ? (
                  <Txt as="p" variant="caption" tone="muted" className="mt-1">
                    {authErrorDescription}
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
            ) : credentialForm ? (
              <>
                <div className="mb-6">
                  <Txt font="display" as="h2" variant="title">
                    {t('welcome.title')}
                  </Txt>
                  <Txt as="p" variant="body" tone="muted" className="mt-2">
                    {t('welcome.description')}
                  </Txt>
                </div>
                <CredentialSignInForm returnTo={returnTo} signUpDisabled={auth.data?.signUpDisabled === true} />
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
