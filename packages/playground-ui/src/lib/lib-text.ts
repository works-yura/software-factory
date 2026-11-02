type LibraryTextTranslator = (text: string) => string;

/**
 * Routes a user-visible English label through the host's translator.
 *
 * The host app (Factory) registers `globalThis.__factoryLibT`; its catalogs are keyed by the English text, so a
 * label without a catalog entry, or a host that registers nothing, renders the English text unchanged.
 * Called at render time, except for labels in module-level constants, which resolve once when the module loads.
 */
export function libText(text: string): string {
  const translate = (globalThis as { __factoryLibT?: LibraryTextTranslator }).__factoryLibT;
  return translate?.(text) ?? text;
}
