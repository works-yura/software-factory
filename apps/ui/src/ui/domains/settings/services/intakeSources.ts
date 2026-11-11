import { createIntakeSourceRegistry } from '@factory/core/boards/intake-sources';
import type { IntakeSourceRegistry } from '@factory/core/boards/intake-sources';

/**
 * The intake sources the route editor offers: the one place the UI names concrete sources. A later
 * tracker (Jira, Linear) is one more descriptor here, built once and never changed.
 */
export const INTAKE_SOURCES: IntakeSourceRegistry = createIntakeSourceRegistry();
