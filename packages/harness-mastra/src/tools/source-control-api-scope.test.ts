import { describe, expect, it } from 'vitest';

import { githubApiReadScope, gitlabApiReadScope } from './source-control-api-scope.ts';

const SLUGS = ['acme/app', 'acme/docs'];

describe('githubApiReadScope', () => {
  it('reads below an environment repository, whatever the case', () => {
    expect(githubApiReadScope({ path: 'repos/acme/app/pulls/7/files' }, SLUGS)).toEqual({ repository: 'acme/app' });
    expect(githubApiReadScope({ path: '/repos/ACME/Docs' }, SLUGS)).toEqual({ repository: 'acme/docs' });
  });

  it('refuses another repository, and paths outside a repository', () => {
    expect(() => githubApiReadScope({ path: 'repos/acme/secret/contents/a' }, SLUGS)).toThrow(
      "acme/secret is not one of this session's repositories (acme/app, acme/docs)",
    );
    expect(() => githubApiReadScope({ path: 'orgs/acme/repos' }, SLUGS)).toThrow('does not read `orgs/acme/repos`');
    expect(() => githubApiReadScope({ path: 'repos/acme/app/pulls?state=all' }, SLUGS)).toThrow('in `query`');
    expect(() => githubApiReadScope({}, SLUGS)).toThrow('Pass the REST `path`');
  });

  it('reads the few endpoints that name no repository', () => {
    for (const path of ['user', 'users/octocat', 'users/factory-app[bot]', 'rate_limit']) {
      expect(githubApiReadScope({ path }, SLUGS)).toEqual({ repository: undefined });
    }
  });

  it('searches only inside environment repositories', () => {
    expect(githubApiReadScope({ path: 'search/issues', query: { q: 'repo:acme/app is:pr crash' } }, SLUGS)).toEqual({
      repository: 'acme/app',
    });
    expect(() => githubApiReadScope({ path: 'search/issues', query: { q: 'crash' } }, SLUGS)).toThrow('repo:<owner>/<repo>');
    expect(() =>
      githubApiReadScope({ path: 'search/issues', query: { q: 'repo:acme/app repo:other/x' } }, SLUGS),
    ).toThrow('other/x is not one');
  });

  it('runs GraphQL queries inside a named environment repository, never mutations', () => {
    const query = 'query { repository(owner: "acme", name: "app") { pullRequest(number: 7) { title } } }';
    expect(githubApiReadScope({ graphql: { query } }, SLUGS)).toEqual({ repository: 'acme/app' });
    expect(() =>
      githubApiReadScope({ graphql: { query: 'mutation { addStar(input: {}) { clientMutationId } }' } }, SLUGS),
    ).toThrow('this one writes');
    expect(() =>
      githubApiReadScope({ graphql: { query: 'query { search(query: "x", type: ISSUE, first: 1) { issueCount } }' } }, SLUGS),
    ).toThrow('must stay inside');
    expect(() =>
      githubApiReadScope({ graphql: { query: 'query($o: String!) { repository(owner: $o, name: "app") { id } }' } }, SLUGS),
    ).toThrow('name its repository literally');
    expect(() =>
      githubApiReadScope({ graphql: { query: 'query { repository(owner: "acme", name: "secret") { id } }' } }, SLUGS),
    ).toThrow('acme/secret is not one');
  });
});

describe('gitlabApiReadScope', () => {
  it('rewrites a project read onto the resolved repository', () => {
    expect(gitlabApiReadScope({ path: 'projects/acme%2Fapp/merge_requests/3/diffs' }, SLUGS)).toEqual({
      repository: 'acme/app',
      suffix: '/merge_requests/3/diffs',
    });
    expect(gitlabApiReadScope({ path: '/api/v4/projects/acme%2Fdocs' }, SLUGS)).toEqual({
      repository: 'acme/docs',
      suffix: '',
    });
  });

  it('refuses another project, paths outside a project and GraphQL', () => {
    expect(() => gitlabApiReadScope({ path: 'projects/acme%2Fsecret/issues' }, SLUGS)).toThrow('acme/secret is not one');
    expect(() => gitlabApiReadScope({ path: 'groups/acme/projects' }, SLUGS)).toThrow('does not read');
    expect(() => gitlabApiReadScope({ graphql: { query: 'query { currentUser { id } }' } }, SLUGS)).toThrow(
      'not available for GitLab',
    );
  });

  it('reads the token user', () => {
    expect(gitlabApiReadScope({ path: 'user' }, SLUGS)).toEqual({ repository: undefined, path: 'user' });
  });
});
