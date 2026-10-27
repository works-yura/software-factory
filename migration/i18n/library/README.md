# Translating @mastra/playground-ui

The library ships hardcoded English labels. `patches/@mastra__playground-ui@<version>.patch`
routes each one through `globalThis.__factoryLibT(text)`, which `apps/ui/src/ui/i18n/index.ts`
installs; translations live in `apps/ui/src/ui/i18n/library/<lang>.json`, keyed by the English text.
Some labels are computed when a module loads, so the language switcher reloads the page.

Regenerate after upgrading the library:

1. List the library modules the app imports:
   `grep -rhoE "from '@mastra/playground-ui/[^']+'" apps/ui/src | sed "s#from '@mastra/playground-ui/##; s#'##" | sort -u > used.txt`
2. `corepack pnpm patch @mastra/playground-ui@<version> --edit-dir <dir>`
3. `python3 migration/i18n/library/scan-strings.py <dir>/dist used.txt strings.json`
4. `python3 migration/i18n/library/wrap-strings.py <dir>/dist strings.json kept.json`
   (prints labels computed at module load; review them)
5. Re-apply the SavedViews "Untitled view" handling (`viewDisplayName`) by hand.
6. Add any new strings from `kept.json` to `apps/ui/src/ui/i18n/library/uk.json`.
7. `npm_config_offline=true corepack pnpm patch-commit <dir>`

`scan-app-strings.py` (run from `apps/ui`) lists hardcoded English left in our own source.
