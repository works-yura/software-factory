import type { IMastraAuthProvider, IOrganizationsProvider } from '@mastra/core/server';

export const LOCAL_USER = {
  id: 'factory-local-developer',
  email: 'developer@localhost',
  name: 'Local developer',
  organizationId: 'factory-local-org',
  organizationMembershipIds: ['factory-local-org'],
} as const;

/**
 * Extra hostnames a loopback proxy may forward to this server, such as `tailscale serve`
 * (`<machine>.<tailnet>.ts.net`). Each must be a bare hostname, never a wildcard.
 */
function trustedProxyHosts(): Set<string> {
  const raw = process.env.FACTORY_LOCAL_DEV_TRUSTED_HOSTS?.trim();
  if (!raw) return new Set();
  const hosts = raw.split(',').map(host => host.trim().toLowerCase());
  for (const host of hosts) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) {
      throw new Error(`FACTORY_LOCAL_DEV_TRUSTED_HOSTS has an invalid hostname: "${host}".`);
    }
  }
  return new Set(hosts);
}

/** Single-user identity for a loopback-only development server. */
export function createLocalDevAuth(): IMastraAuthProvider<typeof LOCAL_USER> & IOrganizationsProvider {
  if (process.env.NODE_ENV !== 'development' || process.env.HOST !== '127.0.0.1') {
    throw new Error('Local development auth requires NODE_ENV=development and HOST=127.0.0.1.');
  }
  const allowedHosts = new Set(['localhost', '127.0.0.1', ...trustedProxyHosts()]);

  return {
    name: 'factory-local-dev',
    async authenticateToken(_token, request) {
      const raw = request instanceof Request ? request : request.raw;
      if (!raw) return null;
      const hostname = new URL(raw.url).hostname;
      if (!allowedHosts.has(hostname)) return null;
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
