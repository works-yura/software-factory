/**
 * Ids that existing data is stored under. Before Google sign-in (ADR-0030) every Factory, project
 * and connection on a server belonged to this one organization, and the owner signed in as this
 * user (local dev auth, then the Firebase owner). Google sign-in keeps them: the owner's user row
 * and the `factory-local-org` organization were moved into better-auth with these ids. Never change
 * them — stored rows are keyed by them.
 */
export const EXISTING_ORGANIZATION_ID = 'factory-local-org';

/** The owner's user id (see {@link EXISTING_ORGANIZATION_ID}). */
export const EXISTING_OWNER_USER_ID = 'factory-local-developer';
