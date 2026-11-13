import type { ProfileSection } from '../profile-section.ts';
import { regex } from '../sbpl.ts';

/**
 * Raw disks and packet capture. Must follow the /dev write allow: Seatbelt applies the last match,
 * and SandVault's profile places this before it, where the later allow wins.
 */
export function denyRawDevices(): ProfileSection {
  return {
    title: 'Raw disks and packet capture: none, whatever /dev allows above.',
    rules: [{ action: 'deny', operations: ['file-read*', 'file-write*'], filters: [regex('^/dev/r?disk'), regex('^/private/dev/r?disk'), regex('^/dev/bpf')] }],
  };
}
