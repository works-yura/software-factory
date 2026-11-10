# Consult round: the engineers who must build this

The pre-mortem finds the business, money, data, failure, auth and blast-radius cases. These lenses are different: they check that the **contract in design.md is buildable by each side without re-deciding it**. Before the spec reaches the team, walk each lens as the engineer who will build that side. Answer every question with a line in `design.md`, or an open question with an owner. "Fine" is not an answer.

Run every lens a full-stack feature has. Skip a lens only when the feature has no such side, and say so. Record the outcome under *Consult round*: per lens, **Agree**, or **Object** with the specific change made (`Object: DTO missing ownerId; added + server-side filter`). An objection you cannot settle yourself goes to the person. The spec does not go to Spec review with an unrecorded lens.

---

## 1. Backend: API contract and data model

- Does every endpoint have method, path, auth requirement, request DTO, response DTO and an error list? Could the OpenAPI be written from this page alone?
- Does every DTO field have a type, nullability and validation rule?
- Does the data model list every entity the feature reads or writes, with fields and nullability? Which fields are indexed or queried?
- Is the transport decision (REST vs direct database access) an ADR, not an assumption?
- Shape change to an existing entity: is there a migration or backfill, and is it reversible? If not, is its task `gate: human`?
- Idempotency and concurrency: a retried create, two writers on one record, a partial failure mid-flow?
- Is the error contract the one the rest of the API uses?

## 2. Mobile: architecture and contract consumption

- Which feature folder and which layers (e.g. `domain → application → data → presentation`) does each change land in? Anything crossing upward?
- Does every new endpoint map to exactly one request and one response DTO in the single API home? Is any feature code building URLs or HTTP clients itself?
- Does all displayed data flow through a repository? Any hardcoded lists?
- State: what owns each screen's state? Any logic that would end up in the view? Any state written after an `await` without a lifecycle guard?
- Navigation: which typed routes are added? Deep links?
- Dates on the wire: ISO-8601 UTC? Calendar dates as dates, not timestamps?
- Offline, loading, error, empty: does every state in the brief's edge cases have a screen state?
- Localization: is every new string a locale key?

## 3. Web and landing: contract consumption and pages

- Which pages, routes and components change, in which repository? Server-rendered, static or client-side?
- Does the web client consume the same DTOs and error contract as mobile, or does it need its own? If so, why, and is that an ADR?
- SEO, analytics events and tracking consent where the landing is touched?
- The same state table as mobile: empty, loading, error, offline, permission denied.

## 4. Security: authorization, data isolation, auth model

- On every request, how is identity verified? Where does the role come from: a trusted claim, never the request body?
- For each user- or company-scoped path: the server-side filter that makes another owner's record unreachable (the BOLA / IDOR line).
- Do database rules and API checks agree? A divergence is a finding.
- Does any privileged capability, key or admin credential reach the client bundle?
- Input: validation on every endpoint, allowlists, no ambiguous parsing?
- Rate limits on auth, expensive and enumeration-prone endpoints?
- What is logged for authentication and authorization decisions, and is any secret or personal data in it?
- Privilege change (role edit, sign-out, account switch): what is invalidated?

## 5. Design: tokens, theme, redline feasibility (UI features only)

- Is there a design for every new screen, at a recorded revision? If not, is producing it a task the UI implementation depends on?
- Every colour, type style, spacing, radius and elevation used: an existing token? New tokens go through the design system, never inline values.
- Every component: default, pressed, disabled, focus, error and loading states specified?
- Responsive and adaptive: what changes at each breakpoint, and which reference proves it?
- Do the redlines fit the layout system (no absolute positioning, no fixed heights that break with long text or large fonts)?
- Accessibility: touch targets, contrast, dynamic type, screen-reader labels.

---

Adapted from eclipt's `spec-driven-planning/references/design-lenses.md` and the consult round of eclipt's `spec` skill; the web and landing lens is added.
