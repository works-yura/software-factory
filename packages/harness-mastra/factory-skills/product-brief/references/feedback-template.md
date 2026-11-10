# feedback/round-<n>.md template (traced client remarks)

Path: `<docs>/changes/<change>/feedback/round-<n>.md`. The archived original is `<docs>/blackbox/sources/<channel>-<YYYY-MM-DD>-<feature>-feedback-round-<n>.md`.

Rules:

- **The client's text is the spine.** Quote it verbatim with `>`; never fix typos, grammar or language. Your text only ever appears in labelled blocks *below* the quote.
- **Coverage is total.** Every paragraph of the source maps to a block. A greeting gets `context — no action`. A missing block means "not processed yet".
- **One block = one independently checkable ask.** "Sort by date, and pull-to-refresh reloads" is two blocks.
- **Ids are permanent:** `FB-<round>-001`, `FB-<round>-002`, … in source order. Never renumber; a split becomes `FB-2-014a` / `FB-2-014b`. Record the client's own numbering as `Source ref:`, never as the id.
- Statuses: `open` · `done` · `answered` (a question) · `context` · `needs-decision` · `declined` · `deferred` · `blocked`.

````markdown
# <Feature>: client remarks, round <n>

Source: <blackbox/sources/<channel>-<YYYY-MM-DD>-<feature>-feedback-round-<n>.md> · received <date> · <OCR'd / transcribed, if so>

## Ledger
| Id | Title | Status |
|---|---|---|
| FB-2-001 | Greeting | context |
| FB-2-002 | Points visible on the receipt | done |
| FB-2-003 | Can points expire? | needs-decision |

## <Client's own section heading, if any>

### FB-2-001 — Greeting
> <verbatim text>

**Status:** context — no action (a greeting)

### FB-2-002 — Points visible on the receipt
> <verbatim text>

Source ref: <§3.2, if the client numbered it>
**Status:** done
**Solution:** <what changed in requirements.md, which section, and why that satisfies this exact quote; real values: wording, limits, order>
**Verify:** requirements.md → <section / UC id / AC number>, where the client sees <expected text>

### FB-2-003 — Can points expire?
> <verbatim text>

**Status:** needs-decision
**Question for <who>:** <the decision, with the options and your recommendation>

## Open questions
- FB-2-003 — <decision> — <who decides>
````

Self-check before reporting: every paragraph of the archived source maps to a block; quotes are byte-identical; the ledger's rows and statuses match the blocks; every `done` has a Solution and a Verify; every `declined` / `deferred` / `blocked` says what would change it. Report as counts by status plus the ids that are not done.
