import type { AuditAction, AuditEventRow, RecordAuditEventInput } from '@factory/store';

/**
 * Where the runtime writes transition audit. v3 passed its HTTP-aware `AuditDomain`
 * here; anything with this `record` works, `AuditStorage` included.
 */
export interface AuditRecorder {
  record(input: RecordAuditEventInput<AuditAction>): Promise<AuditEventRow | null>;
}
