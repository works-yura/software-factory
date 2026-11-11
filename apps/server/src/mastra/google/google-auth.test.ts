import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { MastraAuthBetterAuth } from '@factory/auth-better-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_USER } from '../local/local-dev-auth';
import { createGoogleAuth, existingUsersFromEnv, moveExistingUsers, readFirebaseExport } from './google-auth';

const SECRET = 'a-session-secret-of-at-least-32-characters';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-google-auth-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A file in the shape of `firebase auth:export users.json --format=json`. */
function firebaseExport(users: unknown[]): string {
  const path = join(dir, 'users.json');
  writeFileSync(path, JSON.stringify({ users }));
  return path;
}

const EXPORTED = [
  {
    localId: 'fb-uid-ann',
    email: 'Ann@Example.com',
    emailVerified: true,
    displayName: 'Ann',
    photoUrl: 'https://example.com/ann.png',
    providerUserInfo: [{ providerId: 'google.com', rawId: '1', email: 'ann@example.com' }],
  },
  { localId: 'fb-uid-owner', email: 'owner@example.com', displayName: 'Owner' },
  { localId: 'fb-uid-phone', phoneNumber: '+380000000000' },
];

/** The real provider on a fresh libSQL database, initialized the way the factory does it. */
async function provider(): Promise<MastraAuthBetterAuth> {
  const auth = new MastraAuthBetterAuth({ secret: SECRET, google: { clientId: 'id', clientSecret: 'secret' } });
  await auth.init({ database: { dialect: 'libsql', client: createClient({ url: ':memory:' }) }, publicUrl: 'http://localhost:4111' });
  return auth;
}

async function rows(auth: MastraAuthBetterAuth) {
  const ctx = await auth.authContext();
  return {
    organizations: (await ctx.adapter.findMany({ model: 'organization' })) as Array<{ id: string; name: string }>,
    users: (await ctx.adapter.findMany({ model: 'user' })) as Array<{
      id: string;
      email: string;
      name: string;
      image?: string | null;
      emailVerified: boolean;
    }>,
    members: (await ctx.adapter.findMany({ model: 'member' })) as Array<{ organizationId: string; userId: string; role: string }>,
  };
}

describe('createGoogleAuth', () => {
  function stubComplete() {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('FACTORY_AUTH_SECRET', SECRET);
    vi.stubEnv('MASTRACODE_PUBLIC_URL', 'https://factory.example.com');
  }

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FACTORY_AUTH_SECRET', 'MASTRACODE_PUBLIC_URL'])(
    'stops the boot naming %s when it is missing',
    name => {
      stubComplete();
      vi.stubEnv(name, '');
      expect(() => createGoogleAuth()).toThrow(new RegExp(`FACTORY_AUTH=google needs ${name}`));
    },
  );

  it('refuses a session secret shorter than 32 characters', () => {
    stubComplete();
    vi.stubEnv('FACTORY_AUTH_SECRET', 'short');
    expect(() => createGoogleAuth()).toThrow(/FACTORY_AUTH_SECRET must be at least 32 characters/);
  });

  it('builds the better-auth provider', () => {
    stubComplete();
    expect(createGoogleAuth()).toBeInstanceOf(MastraAuthBetterAuth);
  });
});

describe('existing users from env', () => {
  it('is nothing when neither the owner nor an export is set', () => {
    vi.stubEnv('FACTORY_OWNER_EMAIL', '');
    vi.stubEnv('FACTORY_AUTH_IMPORT_FIREBASE_USERS', '');
    expect(existingUsersFromEnv()).toBeUndefined();
  });

  it('reads the owner email and the people with an email from the export', () => {
    vi.stubEnv('FACTORY_OWNER_EMAIL', ' Owner@Example.com ');
    vi.stubEnv('FACTORY_AUTH_IMPORT_FIREBASE_USERS', firebaseExport(EXPORTED));

    expect(existingUsersFromEnv()).toEqual({
      ownerEmail: 'owner@example.com',
      firebaseUsers: [
        { localId: 'fb-uid-ann', email: 'ann@example.com', name: 'Ann', image: 'https://example.com/ann.png' },
        { localId: 'fb-uid-owner', email: 'owner@example.com', name: 'Owner' },
      ],
    });
  });

  it('stops the boot when the export cannot be read', () => {
    expect(() => readFirebaseExport(join(dir, 'missing.json'))).toThrow(/FACTORY_AUTH_IMPORT_FIREBASE_USERS could not be read/);
    const notAnExport = join(dir, 'other.json');
    writeFileSync(notAnExport, JSON.stringify({ accounts: [] }));
    expect(() => readFirebaseExport(notAnExport)).toThrow(/has no "users" list/);
  });
});

describe('moveExistingUsers', () => {
  it('makes the owner the owner of the existing organization under the local developer id', async () => {
    const auth = await provider();

    const summary = await moveExistingUsers(auth, { ownerEmail: 'owner@example.com', firebaseUsers: [] });

    const { organizations, users, members } = await rows(auth);
    expect(summary).toMatchObject({ organization: 'created', owner: 'created' });
    expect(organizations).toEqual([expect.objectContaining({ id: LOCAL_USER.organizationId })]);
    expect(users).toEqual([expect.objectContaining({ id: LOCAL_USER.id, email: 'owner@example.com', emailVerified: true })]);
    expect(members).toEqual([
      expect.objectContaining({ organizationId: LOCAL_USER.organizationId, userId: LOCAL_USER.id, role: 'owner' }),
    ]);
    // The owner keeps the existing organization: no personal one is bootstrapped.
    expect(await auth.ensureOrganization(LOCAL_USER.id)).toBe(LOCAL_USER.organizationId);
    expect((await rows(auth)).organizations).toHaveLength(1);
  });

  it('adds everyone in the Firebase export as admin under their Firebase uid, except the owner', async () => {
    const auth = await provider();

    const summary = await moveExistingUsers(auth, {
      ownerEmail: 'owner@example.com',
      firebaseUsers: readFirebaseExport(firebaseExport(EXPORTED)),
    });

    const { users, members } = await rows(auth);
    expect(summary.created).toEqual(['ann@example.com']);
    expect(users).toHaveLength(2);
    expect(users).toContainEqual(
      expect.objectContaining({
        id: 'fb-uid-ann',
        email: 'ann@example.com',
        name: 'Ann',
        image: 'https://example.com/ann.png',
        emailVerified: true,
      }),
    );
    expect(members).toContainEqual(
      expect.objectContaining({ organizationId: LOCAL_USER.organizationId, userId: 'fb-uid-ann', role: 'admin' }),
    );
    expect(await auth.isOrganizationAdmin(LOCAL_USER.organizationId, 'fb-uid-ann')).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 people added'));
  });

  it('is idempotent and does not bring back a member the owner removed', async () => {
    const auth = await provider();
    const existing = { ownerEmail: 'owner@example.com', firebaseUsers: readFirebaseExport(firebaseExport(EXPORTED)) };
    await moveExistingUsers(auth, existing);
    const ctx = await auth.authContext();
    await ctx.adapter.delete({ model: 'member', where: [{ field: 'userId', value: 'fb-uid-ann' }] });

    const again = await moveExistingUsers(auth, existing);

    expect(again).toMatchObject({ organization: 'present', owner: 'present', created: [], present: ['ann@example.com'] });
    const { organizations, users, members } = await rows(auth);
    expect(organizations).toHaveLength(1);
    expect(users).toHaveLength(2);
    expect(members.map(member => member.userId)).toEqual([LOCAL_USER.id]);
  });

  it('never overwrites a row whose email already signed in under another id', async () => {
    const auth = await provider();
    const ctx = await auth.authContext();
    const now = new Date();
    await ctx.adapter.create({
      model: 'user',
      data: { id: 'new-google-id', email: 'ann@example.com', name: 'Ann (Google)', emailVerified: true, createdAt: now, updatedAt: now },
      forceAllowId: true,
    });

    const summary = await moveExistingUsers(auth, { firebaseUsers: readFirebaseExport(firebaseExport(EXPORTED)) });

    expect(summary.emailTaken).toEqual(['ann@example.com']);
    const { users } = await rows(auth);
    expect(users.find(user => user.email === 'ann@example.com')).toMatchObject({ id: 'new-google-id', name: 'Ann (Google)' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ann@example.com'));
  });
});
