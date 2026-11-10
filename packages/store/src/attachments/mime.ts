/**
 * The media type an attachment is stored and served with. The content's own signature wins over what
 * the browser declared, the declared type over the extension, and anything unknown is
 * `application/octet-stream`.
 */

const SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
];

const EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  fig: 'application/octet-stream',
};

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The type the first bytes prove, if any. Zip-based Office files keep their declared/extension type. */
export function sniffAttachmentMime(head: Uint8Array): string | undefined {
  if (
    head.length >= 12 &&
    String.fromCharCode(...head.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...head.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (head.length < offset + signature.bytes.length) continue;
    if (signature.bytes.every((byte, index) => head[offset + index] === byte)) return signature.mime;
  }
  return undefined;
}

export function resolveAttachmentMime(input: { head: Uint8Array; declared?: string | null; name: string }): string {
  const fromName = EXTENSIONS[input.name.split('.').pop()?.toLowerCase() ?? ''];
  const declared = input.declared?.split(';')[0]?.trim().toLowerCase();
  const usableDeclared = declared && declared !== 'application/octet-stream' && MIME_RE.test(declared) ? declared : undefined;
  const sniffed = sniffAttachmentMime(input.head);
  // A zip signature is also every Office document; the more specific type stays.
  if (sniffed === 'application/zip') return usableDeclared ?? fromName ?? sniffed;
  return sniffed ?? usableDeclared ?? fromName ?? 'application/octet-stream';
}

/** Types a browser may render in place; everything else downloads, so stored HTML or SVG never runs. */
export function isInlineAttachmentMime(mime: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(mime);
}
