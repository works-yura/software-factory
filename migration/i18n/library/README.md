# Translating @mastra/playground-ui

The library is vendored in `packages/playground-ui` and ships hardcoded English labels. Each one is
wrapped in `libText('English text')` (`packages/playground-ui/src/lib/lib-text.ts`), which calls
`globalThis.__factoryLibT(text)`, installed by `apps/ui/src/ui/i18n/index.ts`. Translations live in
`apps/ui/src/ui/i18n/library/<lang>.json`, keyed by the English text. Some labels are computed when a
module loads, so the language switcher reloads the page.

Adding or changing a label:

1. Wrap the literal in `libText(...)` in the library source (`import { libText } from '@/lib/lib-text'`).
2. Add the English text with its translation to `apps/ui/src/ui/i18n/library/uk.json`.

Finding hardcoded English that is still not wrapped (for example after merging upstream changes):

1. Build the package: `corepack pnpm --filter @mastra/playground-ui build`.
2. List the library modules the app imports:
   `grep -rhoE "from '@mastra/playground-ui/[^']+'" apps/ui/src | sed "s#from '@mastra/playground-ui/##; s#'##" | sort -u > used.txt`
3. `python3 migration/i18n/library/scan-strings.py packages/playground-ui/dist used.txt strings.json`
   lists labels that are still plain string literals in the modules the app uses (wrapped ones do not
   match); wrap them in the source and add the translations.

`scan-app-strings.py` (run from `apps/ui`) lists hardcoded English left in our own source.
