# Pre-mortem: attack the design before it is approved

Plans die in production from the cases nobody modelled, especially **business** cases. A design looks clean on the happy path, gets approved and built, and then a real situation (a refund after partial fulfilment, a booking across a daylight-saving boundary, a coupon on an already-discounted item) turns out to be something the **data model or flow simply cannot represent**. Then the fix is a migration or a rewrite, not a tweak.

Imagine the design has already failed, work backward to *why*, and report specifically **where the system cannot adapt**, so the design is refined before any code is written. The output must make the design **simpler and more predictable**, not bury it under forty what-ifs. Restraint is the point.

## Inputs

1. The design (`design.md`) and the brief (`requirements.md`).
2. The system it lands in: the project's flow, contract and data documents. The data-adaptability and blast-radius lenses are worthless without the current shape of things, so where documents are missing, read the code of the affected models, endpoints and flows.

If you cannot determine the current data model or flow, say so plainly: an unverifiable adaptability claim is worse than an honest "unknown".

## Lenses

Run each lens as a separate, deliberate pass, so they do not converge on the same obvious risk. Each pass returns a few **concrete, high-value findings**, not a brainstorm. Scale the set to the design: a small change may need only 1, 3 and 4; anything touching money or auth needs all six. Say which ran and which were skipped.

1. **Business and domain edges** (first, weighted heaviest). What real-world state does the happy path assume that isn't always true? Lifecycle boundaries: half-done, reversed, expired, superseded, in two states at once? Valid inputs that together make no sense (a discount on a free item, a refund larger than the payment, a booking in the past)? Unusual but real actors (an admin acting for a user, a user with two accounts, a guest who signs up later)? What does the business consider correct that the design does not encode? Which regulatory, policy or contractual rule applies (tax, consent, retention, refund windows)?
2. **Money and state transitions.** Can money move twice if a step retries? Is the operation idempotent when the client resubmits or the webhook fires twice? Payment succeeds but the follow-on write fails, or the other way round: what state is left? Partial success? Currency, rounding, precision, negative and zero amounts? Who reconciles when the provider and our records disagree?
3. **Data adaptability** (the decisive "can our system adapt" lens, answered against the *actual* schema). Can the data model represent each edge case the other lenses raise? Would supporting it later need a migration, backfill or breaking change (name it)? Fields that will need to become nullable, enums that need values, one-to-one relations that need to become one-to-many? Is a business rule encoded as data (good) or buried in code? Which existing rows would violate a new assumption? Is anything stored that can't be corrected or deleted later?
4. **Failure and concurrency.** Timeout, network drop or crash mid-flow: where does it leave things? Safe to retry, or does it compound? Two actors racing on one resource? Ordering assumptions on events that aren't guaranteed? Zero, one and very many items? An external dependency down or slow: degrade, queue or fail?
5. **Auth and permissions.** The wrong role or tier reaching the new capability? A session expiring mid-flow? Can actor A affect actor B's resource through this path? Does the new path bypass a check the old paths enforced? Privilege escalation through a trusted parameter? Data crossing an account or organization boundary?
6. **Blast radius.** Which existing flows, endpoints or jobs read or write the same data or call the same code? Which other components consume a contract this changes (server, mobile, web, landing)? A shared assumption other features silently rely on? Backward compatibility for existing clients, cached data, in-flight requests? What breaks only when a *different* feature is exercised?

## Finding shape

```
### <short title of the case>
- Lens: <business | money | data | failure | auth | blast-radius>
- Scenario: <the concrete situation, with realistic inputs and state>
- What breaks: <wrong result, corrupt state, crash, data that can't be represented>
- Can the system adapt later? <yes, cheaply / no — needs migration X / unknown, couldn't verify Y>
- Bucket: <must-handle-now | safe-to-defer | out-of-scope>
- Why that bucket: <one line — the structural reason>
```

## Triage: the heart of it

Every surviving finding (deduplicated, noise dropped) lands in exactly one bucket. Most should **not** become new work.

- **Must handle now:** the system genuinely can't adapt afterwards; ignoring it means a later migration or rewrite. These reshape the design. Keep the list short and load-bearing (ideally 0–4; more means the design may be too big — say so).
- **Safe to defer:** the design can absorb it later without structural change. On the record, not in the design.
- **Explicitly out of scope:** a conscious decision not to handle the case. Writing it down turns a silent gap into an owned decision.

A finding earns "must handle now" only if you can name the concrete structural reason the system couldn't adapt later. If it could be added later as an increment, it is "safe to defer". Prefer defer.

## Output

Under *Premortem outcome* in `design.md`: the verdict (sound as-is / sound after the must-handles / needs a rethink), the lenses run and skipped, the must-handles with the section each changed, and the deferred and out-of-scope titles, one line each. Fold the must-handles into the design itself: the refined design is the deliverable, and it should read simpler than before. A must-handle you cannot fold in without the person's decision becomes an open question, put to them.

## Principles

- **Business first.** Technical edge cases are easier to catch and get disproportionate attention; the misses that hurt are domain and business rules.
- **Subtractive, not additive.** If the design comes out more complicated than it went in, you did it wrong.
- **Adaptability over enumeration.** Not "every edge case", but "which cases can the system not absorb later".
- **Honest about unknowns.** A flagged unknown is useful; a confident guess is dangerous.
- **Concrete over abstract.** "What if input is invalid" is noise; "a user cancels a booking that's already been partially refunded" is a finding.

---

Adapted from eclipt's `plan-premortem` skill and its `references/lenses.md`. Factory runs the lenses as separate passes in one session rather than parallel sub-agents.
