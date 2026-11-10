# Code quality audit checklist

Scope: the application code of every repository in the environment, measured against the project's own `rules/`. Read-only.

1. **The project's rules.** Read `rules/`; list every place the code breaks one, with the rule quoted.
2. **Type safety and lint.** Run the type checker and linter in no-write mode if they exist (`tsc --noEmit`, `eslint` without `--fix`, `flutter analyze`, `ruff check`); count and group errors.
3. **Tests.** Which areas have tests and which do not; failing or skipped tests; tests that assert nothing. Run the suite only if it is quick and needs no external services.
4. **Hot spots.** Files changed most often in the last 90 days (`git log --since=90.days --name-only`) that are also the largest or most complex — where bugs concentrate.
5. **Error handling.** Swallowed errors, silent fallbacks that hide failures, missing handling on network and storage calls.
6. **Duplication and dead code.** Copies of the same logic, code nothing reaches.
7. **Structure.** Modules that reach across layers, circular imports, god files.

Severity: a pattern that loses or corrupts data or hides failures in production → **critical**/**high**; missing tests on critical flows → **medium**; style and structure → **low**.
