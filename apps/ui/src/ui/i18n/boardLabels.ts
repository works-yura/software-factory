import { i18n } from '.';

/**
 * Board and phase titles come from the server's board definitions (English).
 * Built-in boards have translations keyed by board and phase id; a custom board,
 * or a phase the catalog does not know, keeps the title the server sent.
 */
export function boardTitle(boardId: string, fallback: string): string {
  const key = `${boardId}.title`;
  return i18n.exists(key, { ns: 'boards' }) ? i18n.t(key as never, { ns: 'boards' }) : fallback;
}

export function phaseTitle(boardId: string, phaseId: string, fallback: string): string {
  const key = `${boardId}.phases.${phaseId}`;
  return i18n.exists(key, { ns: 'boards' }) ? i18n.t(key as never, { ns: 'boards' }) : fallback;
}
