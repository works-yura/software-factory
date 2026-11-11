# Security audit checklist

Scope: the code, configuration and CI of every repository in the environment. Read-only.

1. **Secrets in the repository.** `git grep` for keys, tokens, private keys, connection strings and `.env` files committed (current tree and `git log -p --all -S` for the obvious prefixes: `sk-`, `AKIA`, `ghp_`, `xox`, `-----BEGIN`). A live-looking secret is **critical**; one in history only is **high** (it must be rotated).
2. **Known-vulnerable dependencies.** The package manager's audit in report mode (`pnpm audit --json`, `npm audit --json`, `pip-audit`, `osv-scanner`). Rate by the advisory's severity and whether the vulnerable path is reachable from the app.
3. **Authentication and authorization.** Routes or functions reachable without auth that read or change data; checks done only in the client; tenant/organization scoping missing on queries; admin actions without a role check. Data of one customer reachable by another is **critical**.
4. **Input handling.** SQL/NoSQL built from strings, shell commands with user input, HTML rendered without escaping, file paths from input, unvalidated redirects, SSRF (server fetching a URL a user gives).
5. **Transport and storage.** Plain HTTP endpoints, cookies without `Secure`/`HttpOnly`/`SameSite`, permissive CORS (`*` with credentials), personal data stored unencrypted where the project's rules require otherwise, logs that print tokens or personal data.
6. **Mobile and client apps.** Keys or secrets embedded in the app bundle, debug flags in release builds, cleartext traffic allowed.
7. **CI and infrastructure as code.** Secrets echoed in CI logs, workflows running untrusted PR code with secrets, overly broad cloud permissions in IaC.
8. **Third parties.** New external services in the code not listed in the project's docs (`repositories/`, rules).

Severity: data exposure across customers, a live secret, remote code execution → **critical**; auth bypass for one account, a secret in history, a reachable high advisory → **high**; hardening gaps with a plausible path → **medium**; best-practice gaps → **low**; notes → **info**.
