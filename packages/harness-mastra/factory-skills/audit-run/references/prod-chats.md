# Production chats and logs audit checklist

Scope: what the product's end users actually received in production over the period — the conversations stored in the production database (messages from an AI agent, a bot, system triggers, templates, people) and the server logs around them — checked against the project's own playbook. The playbook, not this file, says what a conversation is, where it lives, which invariants hold and how findings are rated. This checklist says how to run it through Factory tools.

**Production is strictly read-only.** Never call a write tool of the database (`*_add_documents`, `*_update_document`, `*_delete_documents` or anything not marked read-only), never call the product's endpoints, never message a user. If a write tool is in your tool list, do not use it, and note under *Як перевіряли* that its policy should be «Заборонити».

## 1. Find the playbook and the period

1. The card names the playbook path (e.g. `<docs>/rules/prod-chat-audit/README.md`); otherwise look for it under the docs folder's `rules/` (a file about auditing production chats or conversations). **No playbook, no audit:** write a short report saying so and what the project must add (a playbook: where conversations live, what counts as active, the invariants, the severity taxonomy), and finish.
2. Read the whole playbook and every script or file it names. Follow its safety rules over anything here, except that you never use its own credentials or CLI (`gcloud`, service-account keys, `firebase-admin` against production): data comes only through Factory tools (step 2–3). A playbook step that needs a tool you lack is a gap you report, not a reason to improvise access.
3. **Period:** what the card says; otherwise the 24 hours ending at the card's fire time (`intakeRouteOrigin.firedAt` in the card's metadata for a scheduled card, else when the card was created). Write it in UTC in the report.
4. Read the earlier reports the playbook names and the latest report of this kind in `<docs>/audits/`: known bugs are not new findings; say which are still seen.
5. The code that was in production then: the playbook says which branch (e.g. `prod`); read that branch with `git show <branch>:<path>`, never assume the default branch is what ran.

## 2. Logs

Tools: `observability_log_groups` (counts and groups, pages through up to 5000 entries) and `observability_query_logs` (single entries). If they are absent the Factory has no logs source — say so and go on with the database.

1. `observability_log_groups` with `severityAtLeast: WARNING` over the period: total, by service, top groups. For each top group read one full entry with `observability_query_logs` (`text` from its pattern, `service`).
2. Each signal the playbook counts at INFO level (agent outcomes, hand-offs, retries, delivery failures): one `observability_log_groups` call with `text` set to the signal; use `read` as the count (`complete: false` → «at least N»).
3. Server errors per endpoint: `observability_log_groups` with `httpStatusAtLeast: 500`.
4. A signal the playbook reads from a structured field the tools cannot filter on (a JSON field's presence) cannot be counted: say so under *Як перевіряли* rather than estimating it.

## 3. Conversations from the database

Tools: the read-only database tools of the Factory's database server («База»; MCP Toolbox for Firestore names them `<server>_list_collections`, `<server>_query_collection`, `<server>_get_documents`). Results are masked (phones, emails, tokens → `[phone]`, `[email]`…): never try to unmask, never ask for the raw value.

Know the tools' limits (MCP Toolbox `--prebuilt firestore` 1.16):
- `query_collection` reads **one** collection path: there is no collection-group query, so walk the hierarchy the playbook describes (e.g. every business, then its `chats`). `filters` and `orderBy` are required (pass `[]` and `""` for none). `limit` defaults to 100.
- **Filters on time fields do not work** (an ISO string or `{"timestampValue": …}` never matches a Timestamp field): order by the time field instead (`{"field":"createdAt","direction":"DESCENDING"}`) with a `limit`, and keep what falls in the period yourself; raise `limit` when the oldest returned item is still inside the period. A document without the ordered field is not returned by an ordered query — when the playbook's «active» rule reads several fields, say how many you could check.
- Timestamps come back as ISO strings; numbers of 9+ digits inside documents (epoch seconds or milliseconds stored as numbers or strings) come back masked as `[phone]` — use the Timestamp fields.
- Every result enters your context. Keep calls narrow; a day of a busy product can be thousands of messages — if it cannot all be read, read the chats the logs point to and an even sample across businesses, and say «прочитано N з M».

Steps:
1. The parent records the playbook needs (e.g. all businesses with their mode / settings).
2. The active conversations in the period, by the playbook's rule.
3. Their messages in the period.
4. **Write what you gathered only into the sandbox scratch** — `.factory/scratch/<card-date>/` (create it; `.factory/` is never committed). Never put a dump in the docs, the report, the chat or a card. Delete nothing in production; nothing to delete in the scratch either — the session's folder goes with it.

## 4. Invariant checks

If the playbook has a checker (a script over a dump, e.g. `check.js`), write the dump in exactly the shape the playbook documents for its input (file names, one JSON object per line, field names, timestamp shape — convert the ISO strings if it asks for `{_seconds}`), then run it read-only from the scratch folder against the repository's copy of its helpers (no install, no network). If the checker's input needs fields the masking removed, say which rule could not be checked. No checker: apply the playbook's invariants by reading.

## 5. Read conversations by hand

As the playbook says. At least: every conversation with an invariant hit; every one the logs tie to a failure, hand-off or empty reply; and a sample of clean ones across businesses. Confirm each finding with the playbook's questions (who did it, which code was in production, how many times in how many businesses, already fixed elsewhere, a deliberate decision).

## 6. Rate and report

- Classify with the playbook's taxonomy (type and priority). Map its priorities to this skill's severities: **P0 → critical, P1 → high, P2 → medium**; scale raises a priority if the playbook says so. Not-a-bug and watch items are `info` with their evidence.
- Use the playbook's report template inside this skill's layout. Numbers only as counted.
- **Never a name or a full phone number.** A conversation is «<business> …<last 4 digits of its id>»; a person is their role (клієнтка, власниця). Masked values stay masked.
- Report path `<docs>/audits/<YYYY-MM-DD>-prod-chats.md` on the card's branch, no pull request.
- P0/P1 (critical/high) findings go to a person with one question before moving the card to Done, each named by business and the conversation's last 4 digits, with the recommended next step.
