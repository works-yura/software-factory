import type { ProfileSection } from '../profile-section.ts';
import { subpath } from '../sbpl.ts';

/** No other disk, mounted, removable or network; the startup disk stays reachable through /Volumes. */
export function denyOtherVolumes(): ProfileSection {
  return {
    title: 'Other disks: none (the card folders are re-allowed below).',
    rules: [
      { action: 'deny', operations: ['file-read*'], filters: [subpath('/Volumes')] },
      { action: 'allow', operations: ['file-read*'], filters: [subpath('/Volumes/Macintosh HD')] },
    ],
  };
}
