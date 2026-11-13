import type { ProfileSection } from '../profile-section.ts';
import { globalName } from '../sbpl.ts';

/** No mounting: disk arbitration (`diskutil`, `hdiutil`), network shares, Finder over Apple events. */
export function denyMounting(): ProfileSection {
  return {
    title: 'Mounting: none.',
    rules: [
      { action: 'deny', operations: ['file-mount', 'file-unmount'] },
      {
        action: 'deny',
        operations: ['mach-lookup'],
        filters: [
          globalName('com.apple.DiskArbitration.diskarbitrationd'),
          globalName('com.apple.NetAuthAgent'),
          globalName('com.apple.NetAuthSysAgent'),
          globalName('com.apple.appleeventsd'),
        ],
      },
    ],
  };
}
