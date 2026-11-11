# Performance audit checklist

Scope: the code paths that run per request, per render or per item, in every repository in the environment. Read-only: no load tests against shared or production systems.

1. **Data access.** Queries in loops (N+1), missing indexes for the filters and sorts the code uses (compare with migrations/schema), unbounded reads with no pagination or limit.
2. **Network.** Sequential calls that could run together, calls without timeouts, repeated fetches of the same data with no cache.
3. **Client rendering.** Lists without virtualization, re-renders on every keystroke, large images without sizing, bundles that ship whole libraries for one function (check the build output's sizes if a build is cheap).
4. **Background work.** Jobs or schedules that scan whole tables, retries without backoff, work done in request handlers that could be queued.
5. **Mobile.** Work on the main thread, unbounded caches, polling where push exists.
6. **Measurements that exist.** Any recorded metrics, traces or bundle reports in the repositories; compare with the previous audit.

Severity: a path that times out or fails at current data sizes → **critical**/**high**; a path that grows linearly with data where it should not → **medium**; micro-optimizations → **low**.
