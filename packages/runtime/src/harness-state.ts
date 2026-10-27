/**
 * Session state as the harness defines it. v3 pinned this to Mastra Code's
 * `MastraCodeState`; the runtime only hands it through to request contexts, so
 * it stays opaque here and the harness package supplies the real shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque pass-through, see above
export type HarnessSessionState = any;
