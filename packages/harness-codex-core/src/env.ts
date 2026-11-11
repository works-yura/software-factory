// The environment a `codex app-server` runs with: what a shell and Codex itself need (paths, locale,
// proxies, Codex's own settings), never the server's credentials. A host signs a run in with the
// tokens it holds (see `CodexSessionConfig.credentials`), in the session's own `CODEX_HOME`.

export const DEFAULT_CODEX_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'CODEX_HOME',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
];

const ALLOWED_ENV_PREFIXES = ['LC_', 'XDG_'];

export function buildCodexEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> = {},
  passEnv: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set<string>([...DEFAULT_CODEX_ENV_ALLOWLIST, ...passEnv]);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (allowed.has(key) || ALLOWED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) env[key] = value;
  }
  return { ...env, ...extra };
}
