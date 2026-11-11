# Stability audit checklist (logs and crashes)

Scope: what the running product reported in the audit window — server logs (Cloud Logging) and app crashes (Crashlytics) — read through `observability_query_logs`, `observability_crash_issues` and `observability_crash_issue`, then traced to the code. Default window: the last 7 days (or since the previous stability report, at most 31 days for logs and 90 for crashes). Read-only: never change issue states, never call the product's APIs.

**No source, no audit.** If these tools are not in your tool list, the Factory has no connected Firebase project: write a short report saying so and what an admin must do (Settings › Logs and crashes; runbook `docs/runbooks/firebase-observability.md` in the Factory docs), and move on. If a tool answers with `missingRole` or `fix`, put that in the report under *Як перевіряли* — it is the admin's next step, not a finding.

1. **Crash overview.** `observability_crash_issues` for each mapped app over the window: the top issues by events and impacted users, split by type (FATAL, NON_FATAL, ANR). Note the latest app version and whether its crash count is higher than the previous version's (filter by `version`).
2. **New and regressed issues.** Issues first seen in the window, or first seen in the latest version, or growing against the previous report. These matter more than old, stable noise.
3. **Each top issue (at most 5).** `observability_crash_issue` with 2–3 events: the blamed frame and stack, the breadcrumb logs, the devices and OS versions. Find the code (`git grep` the blamed symbol/file), say the likely cause, and whether a fix is already in the repository but unreleased.
4. **Server errors.** `observability_query_logs` with `severityAtLeast: ERROR` over the window (page with `nextPageToken` while it is useful; stop at a few hundred entries): group by service and by message pattern (strip ids and numbers), count each group, find when it started. Then `CRITICAL` and above separately.
5. **Request failures.** Entries with a `request` field returning 5xx: which endpoints, how often, since when. 4xx spikes on auth endpoints may be a security signal — note them for the security audit.
6. **Timeouts and retries.** Messages about deadlines, timeouts, retries, quota or memory limits (`text` filters such as `timeout`, `deadline`, `quota`, `memory`), per service.
7. **Correlate.** A crash or error group that starts at a release, a deploy or a dependency change (`git log` around that date) is evidence of a regression; say which commit range.
8. **Compare** with the previous stability report: fixed, still open, new.

Severity:
- **critical** — a FATAL crash or a 5xx/error group hitting a core flow (sign-in, booking, payment, data loss) for a large share of users or sessions now;
- **high** — a new or regressed crash in the latest version, or an error group growing day over day on a core flow;
- **medium** — a stable crash or error group with real but limited impact;
- **low** — rare, non-fatal, or on an old version nobody uses;
- **info** — noise worth silencing (expected errors logged as ERROR).

Never paste raw log lines with personal data into the report: the tools already mask it — keep the masks, and quote the shortest decisive part of a message.
