export type ReadTextFileResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'tooLarge' | 'binary' | 'unreadable' };

/**
 * Reads a chosen or dropped file as text, refusing what the server would
 * refuse: more than `maxLength` characters (the limits count characters), or a
 * NUL byte (a binary file). A UTF-8 file over twice `maxLength` bytes always
 * has more than `maxLength` characters, so it's refused without reading it.
 */
export async function readTextFile(file: File, maxLength: number): Promise<ReadTextFileResult> {
  if (file.size > maxLength * 2) return { ok: false, reason: 'tooLarge' };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (text.length > maxLength) return { ok: false, reason: 'tooLarge' };
  if (text.includes('\0')) return { ok: false, reason: 'binary' };
  return { ok: true, text };
}
