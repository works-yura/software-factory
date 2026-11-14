import { DEPENDABOT_ALERT_SOURCE_TYPE, sourceRepository } from '@factory/core';
import { externalAdapter, mergedState } from './base.ts';

const GITHUB_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/;
const DEPENDABOT_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/security\/dependabot\/(\d+)/;

function githubNumber(metadata: Record<string, unknown>, pullRequest: boolean): unknown {
  return (pullRequest ? metadata.githubPullRequestNumber : metadata.githubIssueNumber) ?? metadata.number;
}

/** GitHub issues and pull requests (`acme/app#12`), and Dependabot alerts (`acme/app/dependabot#3`). */
export const githubWorkItemAdapter = externalAdapter('github', {
  providerMetadataKeys: [
    'githubRepositoryId',
    'githubIssueNumber',
    'githubPullRequestNumber',
    'githubAssigneesUpdatedAt',
    'draft',
    'merged',
    'headBranch',
    'baseBranch',
    'requestedReviewers',
    // A Dependabot alert's advisory (`dependabot-alert` sources).
    'dependabotSeverity',
    'dependabotEcosystem',
    'dependabotPackage',
    'dependabotManifestPath',
    'dependabotAdvisory',
    'dependabotCve',
    'dependabotFixedIn',
  ],
  key: (source, metadata) => {
    if (source.type === DEPENDABOT_ALERT_SOURCE_TYPE) {
      const alert = source.url ? DEPENDABOT_URL.exec(source.url) : null;
      return alert ? `${alert[1]}/dependabot#${alert[2]}` : null;
    }
    const match = source.url ? GITHUB_URL.exec(source.url) : null;
    if (match) return `${match[1]}#${match[2]}`;
    const number = githubNumber(metadata, source.type === 'pull-request');
    return typeof number === 'number' ? `#${number}` : null;
  },
  state: mergedState,
  repository: ({ key }) => sourceRepository('github', key),
});
