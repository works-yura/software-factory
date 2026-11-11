/**
 * Browsers paint a multipart/x-mixed-replace part only once the next part begins, and the hub
 * writes a part only when the screen changes. Left alone, an `<img>` viewer never shows a still
 * screen (clients such as the iOS app then give up waiting for the first frame) and always hides
 * the last frame of a change. Re-sending the last part after a short quiet period makes it paint.
 */
const STILL_FRAME_DELAY_MS = 100;

const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 16 * 1024;
// Simulator frames are far smaller; a larger claim is unknown framing, not something to retain.
const MAX_PART_BYTES = 16 * 1024 * 1024;

type Part = ReadonlyArray<Uint8Array>;

const partLength = (headers: string) => {
  if (!headers.startsWith('--')) return undefined;
  const length = Number(/^content-length:\s*(\d+)\s*$/im.exec(headers)?.[1]);
  return length <= MAX_PART_BYTES ? length : undefined;
};

const endsWithCrlf = (part: Part) => {
  const last = part.at(-1)!;
  const cr = last.length > 1 ? last.at(-2) : part.at(-2)?.at(-1);
  return cr === 0x0d && last.at(-1) === 0x0a;
};

/**
 * Follows the hub's part framing (`--frame`, `Content-Length`, CRLF CRLF, body, CRLF; each part
 * is one write) and keeps the last complete part as views into the forwarded chunks, so frame
 * bytes are never copied. Any other framing turns tracking off and the rest passes through.
 */
const partTracker = () => {
  let pieces: Array<Uint8Array> = [];
  let size = 0;
  let partEnd: number | null = null;
  let tracking = true;
  return {
    /** The last complete part, while the stream sits at a part boundary. */
    still: null as Part | null,
    feed(chunk: Uint8Array) {
      if (!tracking) return;
      let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let part: Part | undefined;
      while (rest.length > 0) {
        if (partEnd === null) {
          // A header split across chunks is re-scanned per chunk. Only a header-sized
          // prefix of the new chunk joins the scan, so frame bytes are never copied.
          const head =
            size === 0 ? rest : Buffer.concat([...pieces, rest.subarray(0, MAX_HEADER_BYTES + HEADER_END.length)]);
          const headerEnd = head.indexOf(HEADER_END);
          if (headerEnd < 0 && head.length <= MAX_HEADER_BYTES) {
            pieces.push(rest);
            size += rest.length;
            break;
          }
          const length =
            headerEnd < 0 || headerEnd > MAX_HEADER_BYTES
              ? undefined
              : partLength(head.subarray(0, headerEnd).toString('latin1'));
          if (length === undefined) {
            tracking = false;
            break;
          }
          partEnd = headerEnd + HEADER_END.length + length + 2;
        }
        const taken = rest.subarray(0, partEnd - size);
        pieces.push(taken);
        size += taken.length;
        rest = rest.subarray(taken.length);
        if (size < partEnd) break;
        const complete = pieces;
        if (complete.length === 0 || !endsWithCrlf(complete)) {
          tracking = false;
          break;
        }
        part = complete;
        pieces = [];
        size = 0;
        partEnd = null;
      }
      if (!tracking) pieces = [];
      this.still = tracking && size === 0 ? (part ?? this.still) : null;
    },
  };
};

/** Re-sends the latest frame once when the stream goes quiet between frames. */
/** What a stream reader's `read()` resolves to; the DOM lib's `ReadableStreamReadResult` is not in every consumer's lib. */
type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

export const repeatStillFrame = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  const tracker = partTracker();
  let pending: Promise<ReadResult> | null = null;
  const forward = (result: ReadResult, controller: ReadableStreamDefaultController<Uint8Array>) => {
    pending = null;
    if (result.done) {
      controller.close();
      return;
    }
    tracker.feed(result.value);
    controller.enqueue(result.value);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const still = tracker.still;
      if (still === null && pending === null) return forward(await reader.read(), controller);
      pending ??= reader.read();
      if (still === null) return forward(await pending, controller);
      // Timing out the wait leaves the read running, so a frame arriving mid-wait is kept.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STILL_FRAME_DELAY_MS);
      });
      const next = await Promise.race([pending, quiet]);
      clearTimeout(timer);
      if (next !== null) return forward(next, controller);
      tracker.still = null;
      for (const piece of still) controller.enqueue(piece);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
};
