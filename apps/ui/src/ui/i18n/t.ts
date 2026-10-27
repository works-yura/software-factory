import { i18n } from '.';

/**
 * A translator bound to one namespace, for code that renders copy outside a
 * hook (module-level helpers, view models, deep render functions). Call it at
 * render or use time, never to build a module-level constant: the language
 * boundary remounts the app on a switch, but module constants are built once.
 *
 *   const tk = translator("knowledge");   // at module level
 *   <h2>{tk("scopes.title")}</h2>          // at render time
 *   tk("results", { count })               // plural: results_one / results_other
 *
 * Keys used with single quotes are checked against the English catalog by
 * `catalogs.test.ts`; Ukrainian and every other language must carry the same keys.
 */
export function translator(ns: string) {
  const t = i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (key: string, options?: Record<string, unknown>): string => t(key, { ns, ...options });
}
