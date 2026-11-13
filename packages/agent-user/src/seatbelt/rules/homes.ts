import type { ProfileSection } from '../profile-section.ts';
import { subpath } from '../sbpl.ts';

/** No home folder; the agent's own is re-allowed below. */
export function denyHomes(): ProfileSection {
  return { title: 'Homes: none (the agent home is re-allowed below).', rules: [{ action: 'deny', operations: ['file-read*'], filters: [subpath('/Users')] }] };
}
