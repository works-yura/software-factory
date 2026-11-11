import { readFileSync } from 'node:fs';

import { MastraAuthBetterAuth } from '@factory/auth-better-auth';
import type { BetterAuthContext } from '@factory/auth-better-auth';

import { LOCAL_USER } from '../local/local-dev-auth';

/** better-auth refuses shorter secrets; checking here names the setting instead. */
const MIN_SECRET_LENGTH = 32;

/** The organization every existing factory, project and connection lives in. */
const EXISTING_ORGANIZATION = { id: LOCAL_USER.organizationId, name: 'Factory', slug: LOCAL_USER.organizationId } as const;

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`FACTORY_AUTH=google needs ${name}: ${hint}`);
  return value;
}

/**
 * Google sign-in on better-auth (see `@factory/auth-better-auth`). Every missing setting stops the
 * boot by name. The redirect URI to register in Google Cloud is
 * `<MASTRACODE_PUBLIC_URL>/auth/api/callback/google`.
 */
export function createGoogleAuth(): MastraAuthBetterAuth {
  const clientId = required('GOOGLE_CLIENT_ID', 'the OAuth client id (Google Cloud › APIs & Services › Credentials).');
  const clientSecret = required('GOOGLE_CLIENT_SECRET', 'the OAuth client secret of that client.');
  const secret = required('FACTORY_AUTH_SECRET', 'a random session secret, e.g. `openssl rand -base64 32`.');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`FACTORY_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  required(
    'MASTRACODE_PUBLIC_URL',
    'the browser-facing origin; Google redirects back to <MASTRACODE_PUBLIC_URL>/auth/api/callback/google.',
  );
  return new MastraAuthBetterAuth({ secret, google: { clientId, clientSecret } });
}

/** One person from `firebase auth:export <file> --format=json`. */
export interface FirebaseExportedUser {
  localId: string;
  email: string;
  name?: string;
  image?: string;
}

/** Reads the people with an email from a Firebase Auth export; a file that cannot be read stops the boot. */
export function readFirebaseExport(path: string): FirebaseExportedUser[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `FACTORY_AUTH_IMPORT_FIREBASE_USERS could not be read as a Firebase export (${path}): ${(error as Error).message}`,
    );
  }
  const users = (parsed as { users?: unknown }).users;
  if (!Array.isArray(users)) {
    throw new Error(
      `FACTORY_AUTH_IMPORT_FIREBASE_USERS (${path}) has no "users" list; export it with \`firebase auth:export <file> --format=json\`.`,
    );
  }
  return users.flatMap(entry => {
    const user = entry as { localId?: unknown; email?: unknown; displayName?: unknown; photoUrl?: unknown };
    if (typeof user.localId !== 'string' || !user.localId || typeof user.email !== 'string' || !user.email.trim()) {
      return [];
    }
    return [
      {
        localId: user.localId,
        email: user.email.trim().toLowerCase(),
        ...(typeof user.displayName === 'string' && user.displayName ? { name: user.displayName } : {}),
        ...(typeof user.photoUrl === 'string' && user.photoUrl ? { image: user.photoUrl } : {}),
      },
    ];
  });
}

export interface ExistingUsers {
  /** Signs in as the id local dev auth and the previous Firebase sign-in used for the owner. */
  ownerEmail?: string;
  /** People who signed in through Firebase; their Firebase uid stays their user id. */
  firebaseUsers: FirebaseExportedUser[];
}

/** What env asks to move over, or `undefined` when nothing is set. */
export function existingUsersFromEnv(): ExistingUsers | undefined {
  const ownerEmail = process.env.FACTORY_OWNER_EMAIL?.trim().toLowerCase() || undefined;
  const exportPath = process.env.FACTORY_AUTH_IMPORT_FIREBASE_USERS?.trim() || undefined;
  if (!ownerEmail && !exportPath) return undefined;
  return { ownerEmail, firebaseUsers: exportPath ? readFirebaseExport(exportPath) : [] };
}

export interface MoveSummary {
  organization: 'created' | 'present';
  owner?: 'created' | 'present' | 'email-taken';
  created: string[];
  present: string[];
  /** Emails another user row already holds (that person signed in with Google before the move). */
  emailTaken: string[];
}

interface UserRow {
  id: string;
  email: string;
}

async function findUserByEmail(ctx: BetterAuthContext, email: string): Promise<UserRow | null> {
  return (await ctx.adapter.findOne({ model: 'user', where: [{ field: 'email', value: email }] })) as UserRow | null;
}

/**
 * Creates a user row with a given id and its membership in one transaction, so a failure leaves
 * neither and the next boot tries again. Rows that exist are never touched: an owner who removed a
 * moved-over member does not get them back on the next boot.
 */
async function createMember(
  ctx: BetterAuthContext,
  user: { id: string; email: string; name: string; image?: string },
  role: 'owner' | 'admin',
): Promise<void> {
  const now = new Date();
  await ctx.adapter.transaction(async trx => {
    await trx.create({
      model: 'user',
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        ...(user.image ? { image: user.image } : {}),
        // Google sign-in links only to a row with a verified email.
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      forceAllowId: true,
    });
    await trx.create({
      model: 'member',
      data: { organizationId: EXISTING_ORGANIZATION.id, userId: user.id, role, createdAt: now },
    });
  });
}

/**
 * Moves the people of the previous sign-in into better-auth, keeping their user ids so their
 * personal Claude/Codex sign-ins and private sessions stay theirs: the owner as `owner` of
 * `factory-local-org` under the local developer id, everyone in the Firebase export as `admin`
 * (everyone was an administrator before) under their Firebase uid. Idempotent; never overwrites a
 * row and never creates a personal organization for them. Failures stop the boot.
 */
export async function moveExistingUsers(provider: MastraAuthBetterAuth, existing: ExistingUsers): Promise<MoveSummary> {
  const ctx = await provider.authContext();

  let organization: MoveSummary['organization'] = 'present';
  const org = await ctx.adapter.findOne({ model: 'organization', where: [{ field: 'id', value: EXISTING_ORGANIZATION.id }] });
  if (!org) {
    await ctx.adapter.create({
      model: 'organization',
      data: { ...EXISTING_ORGANIZATION, createdAt: new Date() },
      forceAllowId: true,
    });
    organization = 'created';
  }

  const summary: MoveSummary = { organization, created: [], present: [], emailTaken: [] };

  if (existing.ownerEmail) {
    const ownerRow = await ctx.internalAdapter.findUserById(LOCAL_USER.id);
    if (ownerRow) {
      summary.owner = 'present';
      if (ownerRow.email !== existing.ownerEmail) {
        console.warn(
          `[auth] FACTORY_OWNER_EMAIL is ${existing.ownerEmail}, but the owner row already has ${ownerRow.email}; left as it is.`,
        );
      }
    } else if (await findUserByEmail(ctx, existing.ownerEmail)) {
      summary.owner = 'email-taken';
    } else {
      await createMember(ctx, { id: LOCAL_USER.id, email: existing.ownerEmail, name: existing.ownerEmail }, 'owner');
      summary.owner = 'created';
    }
  }

  for (const person of existing.firebaseUsers) {
    if (person.email === existing.ownerEmail) continue;
    if (await ctx.internalAdapter.findUserById(person.localId)) {
      summary.present.push(person.email);
      continue;
    }
    if (await findUserByEmail(ctx, person.email)) {
      summary.emailTaken.push(person.email);
      continue;
    }
    await createMember(ctx, { id: person.localId, email: person.email, name: person.name ?? person.email, image: person.image }, 'admin');
    summary.created.push(person.email);
  }

  const parts = [
    `organization ${EXISTING_ORGANIZATION.id} ${summary.organization}`,
    ...(summary.owner ? [`owner ${summary.owner}`] : []),
    `${summary.created.length} people added, ${summary.present.length} already there`,
  ];
  console.log(`[auth] Existing users: ${parts.join('; ')}.`);
  if (summary.owner === 'email-taken' || summary.emailTaken.length > 0) {
    const emails = [...(summary.owner === 'email-taken' ? [existing.ownerEmail] : []), ...summary.emailTaken];
    console.warn(
      `[auth] Not moved, these emails already signed in with Google under a new id: ${emails.join(', ')}. ` +
        'Their earlier sessions and sign-ins stay under the old id.',
    );
  }
  return summary;
}
