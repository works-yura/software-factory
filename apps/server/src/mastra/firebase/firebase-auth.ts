import { readFileSync } from 'node:fs';

import type { IMastraAuthProvider, IOrganizationsProvider } from '@mastra/core/server';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import type { ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { DecodedIdToken } from 'firebase-admin/auth';

import { LOCAL_USER } from '../local/local-dev-auth';

/** HttpOnly cookie holding the Firebase session cookie minted at sign-in. */
export const FIREBASE_SESSION_COOKIE = 'factory_session';
const SESSION_DAYS = 5;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
/** A sign-in must hand over a freshly issued ID token, not one lifted from an old tab. */
const MAX_SIGN_IN_AGE_SECONDS = 5 * 60;

/** The Firebase Admin calls the provider makes; tests pass a fake. */
export interface FirebaseTokenVerifier {
  verifyIdToken(idToken: string): Promise<DecodedIdToken>;
  verifySessionCookie(sessionCookie: string): Promise<DecodedIdToken>;
  createSessionCookie(idToken: string, options: { expiresIn: number }): Promise<string>;
}

/** What the browser needs to open the Google sign-in popup. Public values, not secrets. */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

export interface FirebaseAuthOptions {
  /** Lower-cased emails that may sign in. Everyone else is refused. */
  allowedEmails: readonly string[];
  /**
   * The email that signs in as the identity local dev auth uses, so the owner keeps the
   * sessions and settings they made before switching to Google sign-in.
   */
  ownerEmail?: string;
  webConfig: FirebaseWebConfig;
  verifier: FirebaseTokenVerifier;
}

export interface FirebaseUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  organizationId: string;
  organizationMembershipIds: string[];
}

function emailList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function readCookie(request: Request | undefined, name: string): string | undefined {
  const header = request?.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
}

function sessionCookieHeader(value: string, request: Request): string {
  const secure = isHttps(request) ? '; Secure' : '';
  return `${FIREBASE_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Lax${secure}`;
}

function clearSessionCookieHeader(): string {
  return `${FIREBASE_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** A cross-site page must not be able to plant a session in this browser. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Google sign-in through Firebase Authentication. The browser signs in with a popup and hands the
 * ID token to `POST /auth/api/session`; the server checks the email against the allow-list and
 * answers with an HttpOnly Firebase session cookie, which every later request carries.
 */
export function createFirebaseAuthProvider(
  options: FirebaseAuthOptions,
): IMastraAuthProvider<FirebaseUser> & IOrganizationsProvider {
  const allowed = new Set(options.allowedEmails.map(email => email.toLowerCase()));
  if (allowed.size === 0) throw new Error('Firebase sign-in needs at least one allowed email.');
  const ownerEmail = options.ownerEmail?.toLowerCase();
  if (ownerEmail && !allowed.has(ownerEmail)) {
    throw new Error(`The Firebase owner email ${ownerEmail} is not in the allowed emails.`);
  }
  const { verifier } = options;

  const toUser = (claims: DecodedIdToken): FirebaseUser | null => {
    const email = claims.email?.toLowerCase();
    if (!email || claims.email_verified !== true || !allowed.has(email)) return null;
    return {
      id: email === ownerEmail ? LOCAL_USER.id : claims.uid,
      email,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      ...(typeof claims.picture === 'string' ? { avatarUrl: claims.picture } : {}),
      organizationId: LOCAL_USER.organizationId,
      organizationMembershipIds: [LOCAL_USER.organizationId],
    };
  };

  const startSession = async (request: Request): Promise<Response> => {
    if (!isSameOrigin(request)) return json({ message: 'Cross-site sign-in refused.' }, 403);
    let idToken: unknown;
    try {
      idToken = ((await request.json()) as { idToken?: unknown }).idToken;
    } catch {
      return json({ message: 'Expected a JSON body with idToken.' }, 400);
    }
    if (typeof idToken !== 'string' || !idToken) return json({ message: 'Expected a JSON body with idToken.' }, 400);

    let claims: DecodedIdToken;
    try {
      claims = await verifier.verifyIdToken(idToken);
    } catch {
      return json({ message: 'Google sign-in could not be verified. Try again.' }, 401);
    }
    if (Date.now() / 1000 - claims.auth_time > MAX_SIGN_IN_AGE_SECONDS) {
      return json({ message: 'This sign-in is too old. Sign in again.' }, 401);
    }
    if (!toUser(claims)) {
      return json({ message: `${claims.email ?? 'This account'} is not allowed to use this Factory.` }, 403);
    }
    const sessionCookie = await verifier.createSessionCookie(idToken, { expiresIn: SESSION_MS });
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(sessionCookie, request) });
  };

  return {
    name: 'firebase',

    async authenticateToken(token, request) {
      const raw = request instanceof Request ? request : request?.raw;
      const sessionCookie = readCookie(raw, FIREBASE_SESSION_COOKIE);
      try {
        if (sessionCookie) return toUser(await verifier.verifySessionCookie(sessionCookie));
        if (token) return toUser(await verifier.verifyIdToken(token));
      } catch {
        return null;
      }
      return null;
    },

    authorizeUser: user => Boolean(user),

    async handleAuthRequest(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname.replace(/^.*\/auth\/api/, '');
      if (request.method === 'GET' && path === '/config') return json(options.webConfig);
      if (request.method === 'POST' && path === '/session') return startSession(request);
      if (request.method === 'POST' && path === '/sign-out') {
        return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
      }
      return json({ message: 'Not found' }, 404);
    },

    getClearSessionHeaders: () => ({ 'Set-Cookie': clearSessionCookieHeader() }),

    // Every allowed person works in the one organization local dev auth uses, so switching sign-in
    // keeps the factories, projects and connections that already exist.
    async ensureOrganization() {
      return LOCAL_USER.organizationId;
    },
    async isOrganizationAdmin(organizationId) {
      return organizationId === LOCAL_USER.organizationId;
    },
  } as IMastraAuthProvider<FirebaseUser> & IOrganizationsProvider;
}

function serviceAccountFrom(raw: string): ServiceAccount & { project_id?: string } {
  const text = raw.trimStart().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  return JSON.parse(text) as ServiceAccount & { project_id?: string };
}

/** Builds the provider from the environment; every missing setting stops the boot by name. */
export function createFirebaseAuth(): IMastraAuthProvider<FirebaseUser> & IOrganizationsProvider {
  const serviceAccountSetting = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!serviceAccountSetting) {
    throw new Error('FACTORY_AUTH=firebase needs FIREBASE_SERVICE_ACCOUNT: the path to the service account JSON.');
  }
  const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim();
  if (!apiKey) throw new Error('FACTORY_AUTH=firebase needs FIREBASE_WEB_API_KEY (Project settings › Your apps).');
  const allowedEmails = emailList(process.env.FACTORY_ALLOWED_EMAILS);
  if (allowedEmails.length === 0) {
    throw new Error('FACTORY_AUTH=firebase needs FACTORY_ALLOWED_EMAILS: the comma-separated emails that may sign in.');
  }

  const serviceAccount = serviceAccountFrom(serviceAccountSetting);
  const projectId = serviceAccount.projectId ?? serviceAccount.project_id;
  if (!projectId) throw new Error('FIREBASE_SERVICE_ACCOUNT has no project_id.');
  const app =
    getApps().find(existing => existing.name === 'factory-auth') ??
    initializeApp({ credential: cert(serviceAccount), projectId }, 'factory-auth');
  const auth = getAuth(app);

  return createFirebaseAuthProvider({
    allowedEmails,
    ownerEmail: process.env.FACTORY_FIREBASE_OWNER_EMAIL?.trim() || undefined,
    webConfig: {
      apiKey,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com`,
      projectId,
    },
    verifier: {
      verifyIdToken: idToken => auth.verifyIdToken(idToken),
      verifySessionCookie: sessionCookie => auth.verifySessionCookie(sessionCookie),
      createSessionCookie: (idToken, sessionOptions) => auth.createSessionCookie(idToken, sessionOptions),
    },
  });
}
