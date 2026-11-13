import type { ProfileSection } from '../profile-section.ts';
import { literal, subpath } from '../sbpl.ts';

/** No keychain but System.keychain, whose public CA roots TLS needs. */
export function denyKeychains(): ProfileSection {
  return {
    title: 'Keychains: none but System.keychain (public CA roots).',
    rules: [
      { action: 'deny', operations: ['file-read*'], filters: [subpath('/Library/Keychains')] },
      { action: 'allow', operations: ['file-read*'], filters: [literal('/Library/Keychains/System.keychain')] },
    ],
  };
}
