import type { ProfileSection } from '../profile-section.ts';
import { literal } from '../sbpl.ts';

/** Process info for `ps`; `ps` itself is setuid and runs unsandboxed. */
export function allowProcesses(): ProfileSection {
  return {
    title: 'Processes: start them, read their info; ps runs unsandboxed (setuid).',
    rules: [
      { action: 'allow', operations: ['process-info*'] },
      { action: 'allow', operations: ['sysctl-read'] },
      { action: 'allow', operations: ['process*'] },
      { action: 'allow', operations: ['process-exec'], filters: [literal('/bin/ps')], modifier: '(with no-sandbox)' },
    ],
  };
}
