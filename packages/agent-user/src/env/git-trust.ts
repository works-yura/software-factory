/**
 * Git refuses a repository another user owns ("detected dubious ownership"), and card folders are
 * cloned by the server as its own user. The agent is told to trust its card folders through
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, as SandVault does for its shared
 * folder, appended after any config entries the environment already carries.
 */
export function withGitTrust(env: Record<string, string>, roots: readonly string[]): Record<string, string> {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const start = Number.isInteger(existing) && existing >= 0 ? existing : 0;
  const result = { ...env };
  roots.forEach((root, offset) => {
    const index = start + offset;
    result[`GIT_CONFIG_KEY_${index}`] = 'safe.directory';
    // `<root>/*`: every repository under the root (git ≥ 2.46 matches the wildcard).
    result[`GIT_CONFIG_VALUE_${index}`] = `${root.replace(/\/+$/, '')}/*`;
  });
  result.GIT_CONFIG_COUNT = String(start + roots.length);
  return result;
}
