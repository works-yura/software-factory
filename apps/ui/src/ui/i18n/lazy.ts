import { i18n } from '.';

// Keys here are built at runtime (`nav:sessions.statuses.${status}`), so they are not checked against the catalogs.
const translate = (key: string): string => (i18n.t as unknown as (key: string) => string)(key);

/**
 * A record whose values are translated when read. Module-level label maps are
 * built once, so plain strings would keep the language the page loaded in.
 */
export function lazyLabels<K extends string>(keys: readonly K[], key: (id: K) => string): Readonly<Record<K, string>> {
  const labels = {} as Record<K, string>;
  for (const id of keys) {
    Object.defineProperty(labels, id, { enumerable: true, get: () => translate(key(id)) });
  }
  return labels;
}

/** A dropdown option whose label is translated when read. */
export function lazyOption<V>(value: V, key: string): { readonly value: V; readonly label: string } {
  return {
    value,
    get label() {
      return translate(key);
    },
  };
}
