// The environment an `opencode serve` runs with: what a shell and OpenCode need (paths, locale,
// proxies), never the server's credentials (no provider keys, no `OPENCODE_API_KEY`), and every
// place OpenCode keeps state moved into the session's own folders (`XDG_*`): the person's
// `~/.config/opencode` and `~/.local/share/opencode` (their login, their sessions) are never read.
import { join } from 'node:path';

export const DEFAULT_OPENCODE_ENV_ALLOWLIST: readonly string[] = [
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
];

/** `LC_*` only: `XDG_*` of the server's own is replaced by the session's folders, never inherited. */
const ALLOWED_ENV_PREFIXES = ['LC_'];

/** The folders OpenCode keeps a session's state in (its database, its config), under one root. */
export interface OpenCodeStateDirs {
  /** `XDG_CONFIG_HOME`: empty but for what OpenCode writes itself; the Factory's config travels in `OPENCODE_CONFIG_CONTENT`. */
  config: string;
  /** `XDG_DATA_HOME`: the session's OpenCode database (its conversations), what a later run resumes. */
  data: string;
  state: string;
  /** `XDG_CACHE_HOME`: the model list and plugins OpenCode downloads; shared by sessions when the host says so. */
  cache: string;
}

/** A session's state folders under its own root; `cache` may be shared (`sharedCache`). */
export function openCodeStateDirs(root: string, sharedCache?: string): OpenCodeStateDirs {
  return {
    config: join(root, 'config'),
    data: join(root, 'data'),
    state: join(root, 'state'),
    cache: sharedCache ?? join(root, 'cache'),
  };
}

/**
 * Settings that keep a Factory run to itself: no update checks, no Claude Code files of this
 * host (`~/.claude/CLAUDE.md`, its skills), no skills from outside the checkout, the question tool
 * on (a server client answers it), no web UI and no language-server downloads.
 */
export const OPENCODE_FACTORY_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_ENABLE_QUESTION_TOOL: '1',
};

export function buildOpenCodeEnv(
  base: Record<string, string | undefined>,
  input: { dirs: OpenCodeStateDirs; configContent: string; password: string; extra?: Record<string, string> },
  passEnv: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set<string>([...DEFAULT_OPENCODE_ENV_ALLOWLIST, ...passEnv]);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (allowed.has(key) || ALLOWED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) env[key] = value;
  }
  return {
    ...env,
    ...OPENCODE_FACTORY_ENV,
    XDG_CONFIG_HOME: input.dirs.config,
    XDG_DATA_HOME: input.dirs.data,
    XDG_STATE_HOME: input.dirs.state,
    XDG_CACHE_HOME: input.dirs.cache,
    OPENCODE_CONFIG_CONTENT: input.configContent,
    OPENCODE_SERVER_PASSWORD: input.password,
    ...input.extra,
  };
}
