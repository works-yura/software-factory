import type { IMastraAuthProvider, IOrganizationsProvider } from '@mastra/core/server';

const LOCAL_USER = {
  id: 'factory-local-developer',
  email: 'developer@localhost',
  name: 'Local developer',
  organizationId: 'factory-local-org',
  organizationMembershipIds: ['factory-local-org'],
} as const;

/** Single-user identity for a loopback-only development server. */
export function createLocalDevAuth(): IMastraAuthProvider<typeof LOCAL_USER> & IOrganizationsProvider {
  if (process.env.NODE_ENV !== 'development' || process.env.HOST !== '127.0.0.1') {
    throw new Error('Local development auth requires NODE_ENV=development and HOST=127.0.0.1.');
  }

  return {
    name: 'factory-local-dev',
    async authenticateToken(_token, request) {
      const raw = request instanceof Request ? request : request.raw;
      if (!raw) return null;
      const hostname = new URL(raw.url).hostname;
      if (hostname !== 'localhost' && hostname !== '127.0.0.1') return null;
      return LOCAL_USER;
    },
    authorizeUser: () => true,
    async ensureOrganization(userId: string) {
      return userId === LOCAL_USER.id ? LOCAL_USER.organizationId : undefined;
    },
    async isOrganizationAdmin(organizationId: string, userId: string) {
      return organizationId === LOCAL_USER.organizationId && userId === LOCAL_USER.id;
    },
  };
}
