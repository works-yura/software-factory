/**
 * Work's keys, for rows written when Work was the only board: they carry no board, or Work's,
 * and their phases are Work's by name. Only migrations and legacy writers read these.
 */
export const LEGACY_WORK_BOARD = 'work';
export const LEGACY_TRIAGE_PHASE = 'triage';
export const LEGACY_REST_PHASE = 'intake';
