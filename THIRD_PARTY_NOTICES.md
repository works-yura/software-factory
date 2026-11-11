# Third-party notices

Parts of the following paths are derived from T3 Code (source commit 17a6a01d84e3adf9f29df2639d6b6079a434e1b2), used under the MIT License below: `packages/device`, `packages/harness-handoff`, `packages/harness-core/src/models`, `packages/harness-core/src/usage/pricing.ts`, `packages/harness-core/src/usage/limits.ts`, `packages/harness-core/src/usage/contracts.ts`, `packages/harness-claude-code-core/src/usageLimits.ts`, `packages/harness-core/src/elicitation.ts`, `packages/harness-claude-code-core/src/models`, `packages/harness-codex-core`, `packages/harness-codex-ui`, `apps/ui/src/ui/domains/chat/components/modelPicker`.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`packages/auth-better-auth` is derived from `@mastra/auth-better-auth` 1.1.8 (`auth/better-auth` in the Mastra repository, https://github.com/mastra-ai/mastra), Copyright (c) Mastra AI, Inc., used under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: email/password sign-in and sign-up removed, Google is the only provider, organizations without email invitations and without user-created organizations, invitations last 7 days, Google sign-in links to an existing user with the same verified email, a session's active organization is honored only while the user is still a member; see the header of `packages/auth-better-auth/src/index.ts` and `MIGRATION.md`.
