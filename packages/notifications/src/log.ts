/**
 * Where notification events go. Fields carry kinds, channel names and error codes only: an
 * address, a name or the message never reaches a log line.
 */
export interface NotificationLog {
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
  error(event: string, fields?: Record<string, string | number | boolean>): void;
}

/** One JSON line per event on the server's own output (the LaunchAgent writes it to factory.log). */
export const consoleLog: NotificationLog = {
  info: (event, fields) => console.info(JSON.stringify({ scope: 'notifications', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ scope: 'notifications', event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ scope: 'notifications', event, ...fields })),
};

export const silentLog: NotificationLog = { info: () => {}, warn: () => {}, error: () => {} };

/** Provider errors can echo the address; keep a short reason with every address replaced. */
export function scrubReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.replace(/[^\s<>@"']+@[^\s<>@"']+/g, '[address]').slice(0, 200);
}
