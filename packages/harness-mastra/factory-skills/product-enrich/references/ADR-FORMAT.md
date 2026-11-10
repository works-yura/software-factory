# Decision record (ADR) format

Decision records live in the project's single documentation folder: `<docs>/adr/`, or `<docs>/decisions/` when the folder already uses that. Number them sequentially: `0001-<slug>.md`, `0002-<slug>.md`, … Scan the folder for the highest number and add one. Create the folder lazily, when the first record is needed.

## Template

```md
# {Short title of the decision}

{1–3 sentences: the context, what we decided, and why.}
```

That's it. A record can be one paragraph. The value is in recording *that* a decision was made and *why*, not in filling out sections.

## Optional sections

Only when they add real value; most records won't need them.

- **Status** front matter (`proposed | accepted | deprecated | superseded by ADR-NNNN`): useful when a decision is revisited.
- **Considered options**: only when the rejected alternatives are worth remembering.
- **Consequences**: only when non-obvious downstream effects need calling out.

## When to offer a record

All three must hold:

1. **Hard to reverse**: changing your mind later costs something real.
2. **Surprising without context**: a future reader will wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives, and one was picked for specific reasons.

If it is easy to reverse, skip it: you'll just reverse it. If it is not surprising, nobody will wonder why. If there was no real alternative, there is nothing to record.

### What qualifies

- **Architectural shape.** "The write model is event-sourced; the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing talk through domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, payment provider, deployment target. Not every library: only the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; others reference it by id only." The explicit no's are as valuable as the yes's.
- **Deliberate deviations from the obvious path.** "Manual SQL instead of an ORM because X." These stop the next engineer from "fixing" something deliberate.
- **Constraints not visible in the code.** "No AWS because of compliance." "Responses under 200 ms because of the partner contract."
- **Rejected alternatives when the rejection is non-obvious.** If GraphQL was considered and REST picked for subtle reasons, record it, or someone will suggest GraphQL again in six months.

---

Adapted from Matt Pocock's `domain-modeling/ADR-FORMAT.md` (https://github.com/mattpocock/skills), MIT License, Copyright (c) 2026 Matt Pocock.
