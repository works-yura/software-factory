/** Files a person brings into a request: names, types and limits. */

/** Default per-file limit, the same as Factory attachments: 50 MiB. */
export const ASSISTANT_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** At most this many files per message. */
export const ASSISTANT_MAX_FILES_PER_MESSAGE = 10;
const MAX_NAME = 200;

/** A file as it arrives from the panel. */
export interface IncomingFile {
  name: string;
  /** What the browser declared; the bytes' signature wins over it. */
  declaredMime: string | null;
  bytes: Uint8Array;
}

/** A display name safe to store: no directories, no control characters, never empty. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Types the model reads as images (vision). */
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Types a browser may show inline; everything else is served as a download. */
export function isInlineMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime) || mime === 'application/pdf';
}

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

/**
 * The file's type from its first bytes; a declared text type is kept for text, anything else
 * unknown is `application/octet-stream`. Never trusts a declared image or HTML type.
 */
export function sniffMime(bytes: Uint8Array, declared: string | null): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  const base = declared?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (TEXT_MIMES.has(base)) return base;
  return 'application/octet-stream';
}
