import type { ProfileSection } from '../profile-section.ts';
import { subpath } from '../sbpl.ts';

/**
 * Each disk's `.TemporaryItems` folder, for the disks the card folders live on. macOS saves a file
 * there first and moves it into place (an atomic save: Xcode's build manifests, SwiftPM's output
 * maps, `simctl` screenshots); denying it fails those writes with "Operation not permitted".
 * The folder holds one sub-folder per user, guarded by file modes like `/tmp`.
 */
export function allowVolumeTemporaryItems(writableRoots: readonly string[]): ProfileSection {
  const folders = [...new Set(writableRoots.map(volumeOf).filter((volume): volume is string => volume !== undefined))].map(
    volume => `${volume}/.TemporaryItems`,
  );
  return {
    title: 'Atomic saves on the disks of the card folders.',
    rules: folders.length ? [{ action: 'allow', operations: ['file-read*', 'file-write*'], filters: folders.map(subpath) }] : [],
  };
}

/** `/Volumes/<name>` for a path on another disk; undefined on the startup disk. */
function volumeOf(path: string): string | undefined {
  const match = /^\/Volumes\/([^/]+)(?:\/|$)/.exec(path);
  return match && match[1] !== 'Macintosh HD' ? `/Volumes/${match[1]}` : undefined;
}
