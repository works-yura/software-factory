# Archaeology — command recipes

Zero judgment in this file. These are known-working command shapes; adapt them to the repository and preserve only decisive evidence in the review record.

**Shell notes.** `timeout` is not a command on macOS. Quote paths with spaces.

**Tool notes.** Provider reads are Factory tool calls, written below as `tool { input }`. `source_control_api_read` takes query parameters in `query`, never in `path`, and does not paginate: request `{ "per_page": "100", "page": "<n>" }` pages until one comes back short, and pick the fields you need from the JSON yourself. An answer marked `truncated: true` was cut; read a narrower path or page.

## Resolve the PR before prediction

```text
# Keep the first read minimal: number, title, body, author, base branch, url.
source_control_get_change_request { changeRequestId: <pr> }

# Linked issues (closingIssuesReferences) need GraphQL
source_control_api_read { graphql: { query: 'query { repository(owner: "<owner>", name: "<repo>") { pullRequest(number: <pr>) { closingIssuesReferences(first: 20) { nodes { number } } } } }' } }
```

The base branch is the comparison branch; it may not be `main`. Extract the problem statement from the body and ignore implementation/change-list sections until after the pre-diff model is written.

Owner/repo for later calls: the Target repository line in the system prompt, or

```bash
git remote get-url origin
```

## Open the PR after the pre-diff model

```text
# Resolve the head now that isolation is over: head branch and head SHA
source_control_get_change_request { changeRequestId: <pr> }

# Changed files (filename, additions, deletions, patch), every page
source_control_api_read { path: "repos/<owner>/<repo>/pulls/<pr>/files", query: { per_page: "100", page: "<n>" } }

# Commit list (sha, commit.message), every page
source_control_api_read { path: "repos/<owner>/<repo>/pulls/<pr>/commits", query: { per_page: "100", page: "<n>" } }

# Reviews and review-thread comments (with resolved state)
source_control_api_read { graphql: { query: '
  query {
    repository(owner: "<owner>", name: "<repo>") { pullRequest(number: <pr>) {
      reviews(first:50){ pageInfo{hasNextPage endCursor} nodes{ author{login} state submittedAt body } }
      reviewThreads(first:100){ pageInfo{hasNextPage endCursor} nodes{ isResolved isOutdated path line
        comments(first:20){ pageInfo{hasNextPage endCursor} nodes{ author{login} createdAt body } } } }
    }}}' } }
# Follow pageInfo.hasNextPage/endCursor (after: "<endCursor>") on reviews, reviewThreads, and comments
# until exhausted — a truncated history reads as complete and re-raises omitted findings.

# PR-level (issue) comments, every page
source_control_list_change_request_comments { changeRequestId: <pr> }   # follow cursor

# CI status on the head
source_control_api_read { path: "repos/<owner>/<repo>/commits/<headSha>/check-runs" }
source_control_api_read { path: "repos/<owner>/<repo>/commits/<headSha>/status" }
```

If GraphQL is rate-limited, the REST equivalents (every page): `repos/<owner>/<repo>/pulls/<pr>/files`, `.../pulls/<pr>/commits`, `.../pulls/<pr>/reviews` (or `source_control_list_change_request_reviews`), `.../pulls/<pr>/comments` (review comments; no resolved state via REST — note that). Check quota with `source_control_api_read { path: "rate_limit" }` and read `resources.core.remaining` and `resources.graphql.remaining`.

## Linked issues (step 2)

```text
source_control_api_read { path: "repos/<owner>/<repo>/issues/<n>" }            # number, title, user.login, state, labels[].name, body
source_control_api_read { path: "repos/<owner>/<repo>/issues/<n>/comments" }   # user.login, body; every page
```

Also scan the PR body for `#NNN`, `fixes`, `closes`, `resolves` — `closingIssuesReferences` only catches the formally linked ones.

## Base-branch worktree before prediction

```bash
git fetch origin <base>
git worktree add /tmp/review-base-<pr> origin/<base>
```

A clean existing base checkout is also fine. Do not open the PR head until the pre-diff model is written.

## Head and diff after prediction

```bash
# Fork heads are not on origin/<head>; fetch the PR ref and pin the worktree to the head SHA
# <sha>: the head SHA from source_control_get_change_request { changeRequestId: <pr> }
git fetch origin refs/pull/<pr>/head
git worktree add --detach /tmp/review-head-<pr> <sha>
git -C /tmp/review-head-<pr> diff origin/<base>...HEAD --stat
git -C /tmp/review-head-<pr> diff origin/<base>...HEAD
```

## History — when relevant

```bash
# Recent history of each core file (last 20 commits, not the whole log)
git log --oneline -20 origin/<base> -- <file>

# Who wrote the changed lines, in what commit (run on the base worktree against the pre-PR lines)
git blame -L <start>,<end> origin/<base> -- <file>
```

```text
# From a blame SHA to its PR (number, title, html_url)
source_control_api_read { path: "repos/<owner>/<repo>/commits/<sha>/pulls" }
# or
source_control_api_read { path: "search/issues", query: { q: "repo:<owner>/<repo> is:pr is:merged <sha>" } }
```

Read the originating PR's description and review thread. That's where the reason lives.

## History — deep (on trigger)

```bash
# When was a string introduced or removed
git log -S "<exact string>" --oneline origin/<base> -- <path-or-dot>

# Reverts touching the area
git log --oneline origin/<base> --grep="^Revert" -- <path>
```

```text
# The reverted attempt itself: title and body, reviews, comments
source_control_get_change_request { changeRequestId: <n> }
source_control_list_change_request_reviews { changeRequestId: <n> }
source_control_list_change_request_comments { changeRequestId: <n> }

# Closed-unmerged PRs with the same idea (strongest precedent signal); number, title, closed_at, html_url
source_control_api_read { path: "search/issues", query: { q: "repo:<owner>/<repo> is:pr is:closed is:unmerged <feature terms>", per_page: "20" } }

# Issues describing the same symptom under other words
source_control_api_read { path: "search/issues", query: { q: "repo:<owner>/<repo> is:issue <symptom terms>", per_page: "20" } }
```

## Related PRs and issues (when overlap or precedent could matter)

```text
# Open PRs touching the same files (merge-order risk): list the open PRs, then read each one's
# files and keep those with a filename matching <path-fragment>
source_control_api_read { path: "repos/<owner>/<repo>/pulls", query: { state: "open", per_page: "50" } }
source_control_api_read { path: "repos/<owner>/<repo>/pulls/<n>/files", query: { per_page: "100" } }

# By feature/function name, open and closed
source_control_api_read { path: "search/issues", query: { q: "repo:<owner>/<repo> is:pr <term>", per_page: "20" } }
source_control_api_read { path: "search/issues", query: { q: "repo:<owner>/<repo> is:issue <term>", per_page: "20" } }
```

Search terms: the feature name, the file path, the function names touched, the error message from the issue.

## Callers

```bash
# Every reference to a changed symbol, on the PR branch
git grep -nE "\b<symbol>\b" -- '*.ts' '*.tsx' '*.js'

# Including string references (config keys, docs, dynamic imports)
git grep -n "<symbol>" -- ':!*.lock'

# Near-twin helper search: grep for the *verb* and the *shape*, not the name
git grep -nE "function (with|create|make)?[A-Za-z]*(Retry|retry)" -- 'packages/*.ts'
```

Classify every hit: callers to account for versus definitions, comments, documentation, and string references. Read each match before treating it as a caller — a search that also hits the definition or a doc is not evidence of a caller.

## Test on base — when needed

Use this only when code reasoning cannot establish whether the regression evidence would fail without the fix and the answer would materially affect confidence. Never replace production files in the current checkout with base versions. Use a disposable worktree; if it cannot be prepared cleanly, stop rather than falling back to modifying the live checkout.

```bash
ROOT=$(git rev-parse --show-toplevel)
HEAD=<sha>   # the head SHA from source_control_get_change_request { changeRequestId: <pr> }
git fetch origin refs/pull/<pr>/head   # fork heads are not on origin/<head>
MB=$(git merge-base origin/<base> "$HEAD")
WT="${TMPDIR:-/tmp}/review-tob-<pr>-$$"
test ! -e "$WT" || exit 1
git -C "$ROOT" worktree add "$WT" "$MB"
cd "$WT"

# Only the test files the PR added or modified (a deleted path does not exist at $HEAD)
git diff --diff-filter=AM "$MB"..."$HEAD" --name-only -- '**/*.test.*' '**/*.spec.*' '**/__tests__/**' > .test-files
test -s .test-files || { echo "no test files changed — nothing to run"; }
xargs -a .test-files git checkout "$HEAD" --

# Build what the tests need, using the repo's documented shape (AGENTS.md / CONTRIBUTING). Do not improvise build commands.
# Inspect package.json scripts and lockfiles first; run everything with GH_TOKEN and GITHUB_TOKEN unset (the PR's code runs here).
# Then run only those files, keeping the test command's own exit status (pipefail so tail cannot mask a failure):
set -o pipefail
test -s .test-files && env -u GH_TOKEN -u GITHUB_TOKEN xargs -a .test-files pnpm vitest run --reporter=dot --bail 1 2>&1 | tail -40

cd "$ROOT"
git worktree remove --force "$WT"
```

Expected: red. Green means the test doesn't catch the regression — that's a finding, not a success. Record the decisive assertion, not the full output.

## Run the thing (public-api, behavior-change, docs)

A scratch project that consumes the package through its public export, not source imports. Build the package per the repo's documented command first (send build output to a separate log, not the transcript). This executes the PR's code: inspect its scripts and lockfile first and run with GH_TOKEN and GITHUB_TOKEN unset.

```bash
mkdir -p /tmp/review-run-<pr> && cd /tmp/review-run-<pr>
# link or install the workspace package, write a 10-line script that exercises the claim, run it
env -u GH_TOKEN -u GITHUB_TOKEN node demo.mjs 2>&1 | tee /tmp/review-run-<pr>/with.txt
```

For behavior changes, run the same script against a base build into `without.txt`. Summarize the observed difference in the review record; retain transcripts only when they help reproduce it.

## Changeset

```bash
git diff origin/<base>...HEAD --name-only -- .changeset/
cat .changeset/*.md   # on the branch; read the level and the packages
```

## CODEOWNERS / who likely knows

```bash
# Owners for the touched paths
grep -n "<path-fragment>" .github/CODEOWNERS 2>/dev/null
# Or the people who've touched the file most recently
git shortlog -sn --since="1 year ago" origin/<base> -- <file> | head -5
```

Name a person under **Open questions**, not "someone."

## Long memory — recovery searches

| Memory      | What the reviewer "just knows"                      | Recover from                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions   | "We chose X over Y because…"                        | Originating PRs (blame → PR), nearest AGENTS.md, design docs, `git grep -nE "because                                \| workaround \| don't  \| see #" -- <files>` near the changed lines                             |
| Scars       | "Last time someone touched this it broke Z"         | `git log --grep="^Revert" -- <path>`; test names that encode bugs (`git grep -nE "should not                        \| regression \| double \| race" -- <test files>`); `search/issues` with `q: "repo:<owner>/<repo> is:issue <area> regression"` |
| Users       | "Half the community calls this with a string"       | `git grep -n "<api>" -- examples/ docs/`; `search/issues` with `q: "repo:<owner>/<repo> is:issue <api>"`; call sites in the repo                                                                                                                   |
| Conventions | "We always go through the storage abstraction here" | The sibling feature; the three closest public neighbors; the package `CHANGELOG.md` for recent movement in the area                                                                                                  |

## Cleanup

```bash
git worktree remove --force /tmp/review-base-<pr> 2>/dev/null
git worktree remove --force /tmp/review-head-<pr> 2>/dev/null
```

Leave the handoff artifact in place so a re-review can reuse the recorded design and earlier findings.
