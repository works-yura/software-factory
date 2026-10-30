import { describe, expect, it } from 'vitest';

import {
  changeRequestOpenedPatch,
  changeRequestSettledPatch,
  describeChangeRequests,
  hasOpenChangeRequest,
  isOpenChangeRequest,
  namesRepository,
  openChangeRequests,
  ownsChangeRequest,
} from './change-requests.ts';

describe('open change requests across repositories', () => {
  it('keeps one change request per repository and the work open until every one settles', () => {
    let metadata: Record<string, unknown> = {};
    metadata = { ...metadata, ...changeRequestOpenedPatch(metadata, 'works_yura/ai', 5) };
    metadata = { ...metadata, ...changeRequestOpenedPatch(metadata, 'works_yura/test', 5) };

    expect(openChangeRequests(metadata)).toEqual([
      { repository: 'works_yura/ai', number: 5 },
      { repository: 'works_yura/test', number: 5 },
    ]);
    expect(metadata.openPullRequestNumber).toBe(5);
    // The same number in another repository is a different change request.
    expect(isOpenChangeRequest(metadata, 'works_yura/ai', 5)).toBe(true);
    expect(isOpenChangeRequest(metadata, 'works_yura/other', 5)).toBe(false);

    metadata = { ...metadata, ...changeRequestSettledPatch(metadata, 'works_yura/ai', 5) };
    expect(hasOpenChangeRequest(metadata)).toBe(true);
    expect(metadata.openPullRequestNumber).toBe(5);
    expect(describeChangeRequests(openChangeRequests(metadata))).toBe('works_yura/test#5');

    metadata = { ...metadata, ...changeRequestSettledPatch(metadata, 'works_yura/test', 5) };
    expect(hasOpenChangeRequest(metadata)).toBe(false);
    expect(metadata.openPullRequestNumber).toBeNull();
  });

  it('replaces the change request a repository had out when it opens another', () => {
    const first = changeRequestOpenedPatch({}, 'acme/api', 3);
    const second = changeRequestOpenedPatch(first, 'ACME/api', 4);

    expect(second.openChangeRequests).toEqual([{ repository: 'ACME/api', number: 4 }]);
    expect(second.openPullRequestNumber).toBe(4);
  });

  it('settles nothing for a change request the card does not have out', () => {
    const metadata = changeRequestOpenedPatch({}, 'acme/api', 3);

    expect(changeRequestSettledPatch(metadata, 'acme/app', 3)).toBeUndefined();
    expect(changeRequestSettledPatch(metadata, 'acme/api', 4)).toBeUndefined();
    expect(ownsChangeRequest(metadata, 'acme/app', 3)).toBe(false);
    expect(ownsChangeRequest(metadata, 'acme/api', 3)).toBe(true);
    // A card with nothing out lets any change request speak for it.
    expect(ownsChangeRequest({}, 'acme/app', 9)).toBe(true);
  });

  it('reads a card recorded before repositories were named as one entry matching by number', () => {
    const legacy = { openPullRequestNumber: 7 };

    expect(openChangeRequests(legacy)).toEqual([{ repository: '', number: 7 }]);
    expect(isOpenChangeRequest(legacy, 'acme/api', 7)).toBe(true);
    expect(describeChangeRequests(openChangeRequests(legacy))).toBe('#7');
    expect(changeRequestSettledPatch(legacy, 'acme/api', 7)).toEqual({
      openChangeRequests: [],
      openPullRequestNumber: null,
    });
    // Opening in a named repository replaces the unnamed legacy record.
    expect(changeRequestOpenedPatch(legacy, 'acme/app', 8).openChangeRequests).toEqual([
      { repository: 'acme/app', number: 8 },
    ]);
    expect(openChangeRequests({ openPullRequestNumber: null })).toEqual([]);
    expect(openChangeRequests({ openChangeRequests: [{ repository: 'a/b' }, 'junk'] })).toEqual([]);
  });
});

describe('cards that name their repository', () => {
  it.each([
    [{ repository: 'acme/api' }, true],
    [{ githubRepositoryId: 1 }, true],
    [{ gitlabProjectId: '7' }, true],
    [{ repository: '' }, false],
    [{ number: 3 }, false],
    [null, false],
  ])('%j names one: %s', (metadata, expected) => {
    expect(namesRepository(metadata)).toBe(expected);
  });
});
