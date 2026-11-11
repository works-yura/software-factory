# Docs versus code audit checklist

Scope: the project docs (per the docs standard: `features/<area>/design.md` is the truth, `changes/` are deltas, `rules/`, `runbooks/`, `repositories/`) against the code as it is now. Read-only.

1. **Truth by area.** For each `features/<area>/design.md`, check its statements against the code: flows, screens, data, endpoints, roles. Every mismatch is a finding with the doc line and the code location.
2. **Changes not merged into the truth.** Changes in `changes/` whose work has shipped (their cards are Done) but whose deltas were never folded into `features/`.
3. **Undocumented areas.** Code areas (modules, screens, services) with no `features/` entry.
4. **Runbooks.** Commands and steps in `runbooks/` that no longer match scripts, environment variables or infrastructure in the repositories.
5. **Repositories.** `repositories/` entries versus the repositories in the environment (missing, renamed, archived).
6. **Glossary and rules.** Terms used in code or docs with two meanings; rules the code no longer follows (point to the code-quality audit if many).

Severity: a doc that would make someone break production or the client's data (a wrong runbook, a wrong data rule) → **critical**/**high**; wrong behaviour described → **medium**; missing or stale descriptions → **low**.
