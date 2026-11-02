/**
 * What an agent may read through `source_control_api_read`: the provider API
 * of its own environment's repositories, plus the few endpoints that name no
 * repository (the token's user, a user's profile, the rate limit). Every read
 * that names a repository must name one of the environment, so the Factory's
 * credentials never reach a repository the session was not given.
 */

export interface ApiReadRequest {
  path?: string | undefined;
  query?: Record<string, string> | undefined;
  graphql?: { query: string } | undefined;
}

export interface ApiReadScope {
  /** The environment repository the read is about; `undefined` for a read that names none. */
  repository: string | undefined;
}

/** GraphQL fields that reach beyond a named repository. */
const GRAPHQL_UNSCOPED_FIELDS = /\b(search|organization|user|node|nodes|repositoryOwner|enterprise|resource)\s*\(/;
const GRAPHQL_REPOSITORY = /repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"\s*\)/g;
const GITHUB_UNSCOPED_PATHS = [/^user$/, /^users\/[A-Za-z0-9-]+(?:\[bot\])?$/, /^rate_limit$/];
const GITLAB_UNSCOPED_PATHS = [/^user$/, /^users$/];

function environmentSlug(candidate: string, slugs: readonly string[]): string | undefined {
  return slugs.find(slug => slug.toLowerCase() === candidate.toLowerCase());
}

function outside(candidate: string, slugs: readonly string[]): Error {
  return new Error(
    `${candidate} is not one of this session's repositories (${slugs.join(', ')}); the Factory only reads those.`,
  );
}

export function githubApiReadScope(request: ApiReadRequest, slugs: readonly string[]): ApiReadScope {
  if (request.graphql) {
    const query = request.graphql.query;
    if (/\b(mutation|subscription)\b/.test(query)) throw new Error('Only GraphQL queries can be read; this one writes.');
    if (GRAPHQL_UNSCOPED_FIELDS.test(query)) {
      throw new Error('A GraphQL read must stay inside `repository(owner: "...", name: "...")` of this session.');
    }
    const named = [...query.matchAll(GRAPHQL_REPOSITORY)].map(match => `${match[1]}/${match[2]}`);
    if (named.length === 0) {
      throw new Error('A GraphQL read must name its repository literally: `repository(owner: "...", name: "...")`.');
    }
    const repositories = named.map(candidate => {
      const slug = environmentSlug(candidate, slugs);
      if (!slug) throw outside(candidate, slugs);
      return slug;
    });
    return { repository: repositories[0] };
  }
  const path = (request.path ?? '').replace(/^\/+/, '').split('?')[0]!;
  if (!path) throw new Error('Pass the REST `path` to read (for example `repos/<owner>/<repo>/pulls/1`), or a `graphql` query.');
  if (request.path?.includes('?')) throw new Error('Pass query parameters in `query`, not in `path`.');
  if (GITHUB_UNSCOPED_PATHS.some(pattern => pattern.test(path))) return { repository: undefined };
  const repo = /^repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path);
  if (repo) {
    const candidate = `${repo[1]}/${repo[2]}`;
    const slug = environmentSlug(candidate, slugs);
    if (!slug) throw outside(candidate, slugs);
    return { repository: slug };
  }
  if (/^search\/(issues|commits|code)$/.test(path)) {
    const qualifiers = [...(request.query?.q ?? '').matchAll(/\brepo:(\S+)/g)].map(match => match[1]!);
    if (qualifiers.length === 0) throw new Error('A search must name its repository with a `repo:<owner>/<repo>` qualifier in `q`.');
    const repositories = qualifiers.map(candidate => {
      const slug = environmentSlug(candidate, slugs);
      if (!slug) throw outside(candidate, slugs);
      return slug;
    });
    return { repository: repositories[0] };
  }
  throw new Error(`The Factory does not read \`${path}\`: read below \`repos/<owner>/<repo>/\` of this session's repositories.`);
}

/**
 * GitLab names a project by its URL-encoded path (`projects/acme%2Fapp/...`).
 * The read is rewritten onto the project the Factory resolved for that
 * repository (`suffix` goes after its own locator), so it reaches nothing else.
 */
export function gitlabApiReadScope(
  request: ApiReadRequest,
  slugs: readonly string[],
): { repository: undefined; path: string } | { repository: string; suffix: string } {
  if (request.graphql) throw new Error('GraphQL reads are not available for GitLab; use a REST path.');
  const path = (request.path ?? '').replace(/^\/+/, '').replace(/^api\/v4\//, '');
  if (!path) throw new Error('Pass the REST `path` to read (for example `projects/<group%2Fproject>/merge_requests/1`).');
  if (path.includes('?')) throw new Error('Pass query parameters in `query`, not in `path`.');
  if (GITLAB_UNSCOPED_PATHS.some(pattern => pattern.test(path))) return { repository: undefined, path };
  const project = /^projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!project) {
    throw new Error(`The Factory does not read \`${path}\`: read below \`projects/<group%2Fproject>/\` of this session's repositories.`);
  }
  const locator = decodeURIComponent(project[1]!);
  const slug = environmentSlug(locator, slugs);
  if (!slug) throw outside(locator, slugs);
  return { repository: slug, suffix: project[2] ?? '' };
}
