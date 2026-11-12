import { ModelCredentialsStorage } from '@factory/store/credentials/base';
import { createFactorySecretEncryption } from '@factory/store/secret-encryption';
import { LibSQLFactoryStorage } from '@mastra/libsql';

/**
 * Claude Code turns run only on a Claude sign-in of the organization (Settings → Models → Claude Code
 * accounts; the person's own `claude` login is never used). Signing in opens Claude's page in a
 * browser, so the e2e person gets one written straight into the server's database instead: a
 * `claude_login` account with a made-up OAuth pair, encrypted with the server's
 * FACTORY_CREDENTIAL_ENCRYPTION_KEY. The fake `claude` never checks the token; the real one (the live
 * check) would reject it, so the live check keeps signing in for real.
 */
export async function seedClaudeSignIn(options: {
  /** The server's libSQL database (`file:<MASTRA_DB_PATH>`). */
  databaseUrl: string;
  /** The server's FACTORY_CREDENTIAL_ENCRYPTION_KEY (base64, 32 bytes). */
  encryptionKey: string;
  orgId: string;
  userId: string;
}): Promise<void> {
  const storage = new LibSQLFactoryStorage({ id: 'factory-e2e-claude-sign-in', url: options.databaseUrl });
  const credentials = storage.registerDomain(
    new ModelCredentialsStorage(
      createFactorySecretEncryption({ primary: { id: 'v1', key: Buffer.from(options.encryptionKey, 'base64') } }),
    ),
  );
  await storage.init();
  try {
    const accessToken = 'sk-ant-oat01-factory-e2e-fake-claude';
    await credentials.addAccount({
      orgId: options.orgId,
      provider: 'anthropic',
      label: 'Factory E2E (fake claude)',
      kind: 'claude_login',
      ownerUserId: options.userId,
      secret: accessToken,
      oauth: {
        accessToken,
        refreshToken: 'sk-ant-ort01-factory-e2e-fake-claude',
        // Far from expiry, so the server never tries to refresh it with Anthropic.
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      createdBy: options.userId,
    });
  } finally {
    await storage.close();
  }
}
