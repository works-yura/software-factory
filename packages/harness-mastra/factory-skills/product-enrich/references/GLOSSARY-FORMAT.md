# GLOSSARY.md format

The glossary lives at `<docs>/GLOSSARY.md`, in the project's single documentation folder.

## Structure

```md
# {Context name}

{One or two sentences: what this context is and why it exists.}

## Language

**Order**:
{One or two sentences describing the term.}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Rules

- **Be opinionated.** When several words exist for one concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences. Define what it IS, not what it does.
- **Only terms specific to this project.** General programming concepts (timeouts, error types, utility patterns) do not belong, even if the project uses them a lot. Before adding a term, ask: is this unique to this domain, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. A flat list is fine for one cohesive area.
- **Write in the team's language.** Terms may be Ukrainian with the English word the code uses in brackets, or the other way round; pick one convention and keep it.

## Several contexts

Most projects have one context: one `<docs>/GLOSSARY.md`. When the product has clearly separate contexts (ordering, billing, fulfilment), keep a `<docs>/GLOSSARY-MAP.md` listing them, each with its own glossary file **inside the same documentation folder** (`<docs>/glossary/<context>.md`), and how they relate:

```md
# Glossary map

## Contexts
- [Ordering](./glossary/ordering.md): receives and tracks customer orders
- [Billing](./glossary/billing.md): generates invoices and processes payments

## Relationships
- **Ordering → Billing**: Ordering emits `OrderPlaced`; Billing invoices it
```

- If `GLOSSARY-MAP.md` exists, read it to find the contexts.
- If only `GLOSSARY.md` exists, there is one context.
- If neither exists, create `GLOSSARY.md` lazily, when the first term is resolved.

When there are several contexts, infer which one the topic belongs to. If unclear, ask.

---

Adapted from Matt Pocock's `domain-modeling/GLOSSARY-FORMAT.md` (https://github.com/mattpocock/skills), MIT License, Copyright (c) 2026 Matt Pocock.
