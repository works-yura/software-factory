# Layout harness

Every page at 375, 768 and 1280 px in a real Chromium, with the API answered by MSW handlers
in the test process (no server). Each check screenshots the page and fails when the document
scrolls sideways or a visible element ends past the viewport's right edge.

```sh
pnpm --filter ./apps/ui test:layout                      # all pages, all widths
LAYOUT_OUTPUT=/tmp/layout pnpm --filter ./apps/ui test:layout -- --project=phone
```

Screenshots land in `$LAYOUT_OUTPUT/<phone|tablet|desktop>/<name>.png`
(default `apps/ui/test-results/layout`).

- `playwright.layout.config.ts` — its own config (Vite dev server on `:4179`), separate from the
  knowledge-proof config in `../playwright.config.ts`.
- `harness.ts` — `checkPage(page, testInfo, { url, name, handlers })`: mock, open, settle,
  screenshot, assert. `mockApi` answers `/web`, `/auth` and `/api` with the given handlers first,
  then the UI suite's ambient ones (`../ui/msw-server.ts`); calls nobody answers get a 404 and are
  noted on the test (`[layout] … unmocked …`).
- `fixtures/` — data per area, with the long names, emails, URLs and domains real organizations
  have. Add a `<area>.layout.ts` beside `settings.layout.ts` for new pages.
