# Dependency audit checklist

Scope: every manifest and lockfile in the environment (`package.json` + lockfile, `pubspec.yaml`, `requirements*.txt`/`pyproject.toml`, `Podfile.lock`, `build.gradle`, `go.mod`, …). Read-only: never install, update or run `audit fix`.

1. **Vulnerabilities**: the ecosystem's audit in report mode; list each advisory with the dependency path and whether it is a runtime or dev dependency.
2. **Outdated**: `pnpm outdated --format json` / `npm outdated --json` / the ecosystem's equivalent. Group by major versions behind; flag runtimes and frameworks past end of life (Node, Flutter/Dart SDK, React Native, Python) with their EOL date from the vendor's page.
3. **Breaking upgrades ahead**: for each major upgrade worth doing, read its changelog or migration guide and say what would break here.
4. **Unused and duplicate**: dependencies nothing imports; the same library in several major versions.
5. **Licences**: dependencies whose licence conflicts with the project's (copyleft in a closed product).
6. **Lockfile health**: missing or out-of-date lockfile, mixed package managers.

Severity: a reachable critical advisory or an EOL runtime in production → **critical**; a high advisory, a framework two or more majors behind → **high**; outdated minors, unused packages → **low**/**medium**.
