/**
 * The change requests a Work card has out. A card that spans several
 * repositories opens one pull or merge request per repository it changed,
 * and the work is finished only when every one of them is settled. Numbers
 * repeat across repositories (`!5` exists in both), so an entry is the pair.
 *
 * `openPullRequestNumber` is kept alongside as "some change request is still
 * open" for the gates that only ask that; it holds the number of the latest
 * one recorded, or null once none is left.
 */
export interface OpenChangeRequest {
  /** Repository slug (`owner/name`, GitLab `group/project`); empty for a legacy record that never named it. */
  repository: string;
  number: number;
  /** Who numbers it: GitHub pull requests read `#n`, GitLab merge requests `!n`. */
  provider?: 'github' | 'gitlab';
}

type Metadata = Record<string, unknown> | null | undefined;

function isEntry(value: unknown): value is OpenChangeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.repository === 'string' && typeof entry.number === 'number';
}

/** Every change request the card has out, oldest first; a legacy single record reads as one entry with no repository. */
export function openChangeRequests(metadata: Metadata): OpenChangeRequest[] {
  const list = metadata?.openChangeRequests;
  if (Array.isArray(list)) return list.filter(isEntry);
  const legacy = metadata?.openPullRequestNumber;
  return typeof legacy === 'number' ? [{ repository: '', number: legacy }] : [];
}

/** Whether the card still has any change request out. */
export function hasOpenChangeRequest(metadata: Metadata): boolean {
  return openChangeRequests(metadata).length > 0;
}

function sameRepository(entry: OpenChangeRequest, repository: string): boolean {
  // A legacy record without a repository matches by number alone.
  return entry.repository === '' || entry.repository.toLowerCase() === repository.toLowerCase();
}

/** Whether `number` in `repository` is one of the card's open change requests. */
export function isOpenChangeRequest(metadata: Metadata, repository: string, number: number): boolean {
  return openChangeRequests(metadata).some(entry => entry.number === number && sameRepository(entry, repository));
}

/**
 * Whether an event for `number` in `repository` may speak for the card: it is
 * one of the change requests the card has out, or the card has none recorded.
 */
export function ownsChangeRequest(metadata: Metadata, repository: string, number: number): boolean {
  return !hasOpenChangeRequest(metadata) || isOpenChangeRequest(metadata, repository, number);
}

function patchFor(entries: OpenChangeRequest[]) {
  return {
    openChangeRequests: entries,
    openPullRequestNumber: entries.length > 0 ? entries[entries.length - 1]!.number : null,
  };
}

/** The metadata patch recording `number` in `repository` as out. A repository has one change request out at a time. */
export function changeRequestOpenedPatch(
  metadata: Metadata,
  repository: string,
  number: number,
  provider?: OpenChangeRequest['provider'],
) {
  const kept = openChangeRequests(metadata).filter(entry => !sameRepository(entry, repository));
  return patchFor([...kept, { repository, number, ...(provider ? { provider } : {}) }]);
}

/** The metadata patch clearing `number` in `repository`; undefined when the card does not have it out. */
export function changeRequestSettledPatch(metadata: Metadata, repository: string, number: number) {
  const entries = openChangeRequests(metadata);
  const kept = entries.filter(entry => !(entry.number === number && sameRepository(entry, repository)));
  return kept.length === entries.length ? undefined : patchFor(kept);
}

/** `owner/app#12, owner/api#3` for messages; a legacy entry shows its number only. */
export function describeChangeRequests(entries: OpenChangeRequest[]): string {
  return entries.map(entry => (entry.repository ? `${entry.repository}#${entry.number}` : `#${entry.number}`)).join(', ');
}

/**
 * Whether a card names the repository it runs in: an issue's or a pull
 * request's own repository, or one set by hand. A card that names none runs
 * across the Factory's environment, with no default repository.
 */
export function namesRepository(metadata: Metadata): boolean {
  return (
    (typeof metadata?.repository === 'string' && metadata.repository !== '') ||
    metadata?.githubRepositoryId != null ||
    metadata?.gitlabProjectId != null
  );
}
