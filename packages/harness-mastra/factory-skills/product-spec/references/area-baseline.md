# Area baseline: `features/<area>/design.md` when an area has none yet

Read this when the change touches an area that has no `features/<area>/design.md` yet — typically an existing project that never had documentation. A delta can only be written against a truth, so **first describe the area as it is now, then write the delta**.

## Rules

- **Descriptive only.** Describe the area **as it actually is right now**, verified against the code of every repository it spans. If you catch yourself writing work to be done, tasks or acceptance criteria, stop: that is the change, and it goes in `changes/<change>/design.md`.
- **One area, every component.** An area (payments, scheduling, chatbot…) is not owned by a repository. One `features/<area>/design.md` spans server, mobile, web and landing, and links to the contract and data it uses.
- **Never fabricate.** Invented behaviour is worse than a gap. What the code does not make clear is an **open question**, not a guess.
- **Existing single-file docs count.** If `features/<area>.md` (or a similar "how it works now" file) exists, it is the area's truth: verify it against the code, and propose turning it into `features/<area>/design.md` — never move or rewrite it unasked.
- **Its own commit, its own review.** Commit the baseline separately (`docs(baseline): <area>`) before the delta, and tell the person: the baseline is reviewed as "is this how it works today?", the delta as "is this what we want?". The baseline is the one file outside `changes/<change>/` this phase may create, and only when it does not exist.

## Shape

```markdown
# <Area>

status: baseline · verified against: <repo@commit, …> · date: <YYYY-MM-DD>

## Purpose  (Призначення)
<What this area does and the value it delivers, in plain language.>

## Spans  (Охоплює)
<Which repositories / components implement it, e.g. syncta-back + syncta_front + syncta-booking.>

## Requirements  (Вимоги)
### Requirement: <name>
The system SHALL <behaviour as it is now>.
#### Scenario: <name>
- GIVEN <state>
- WHEN <action>
- THEN <observable result>

## Architecture  (Архітектура)
<C4 context/container in Mermaid, when the area crosses components.>

## Flows  (Потоки)
<The main paths end to end: screen → API → data, as sequence diagrams where they cross a boundary; failure and edge paths.>

## Contract & data  (Контракт і дані)
<Endpoints / events / functions it exposes or consumes; the data it reads and writes; invariants.>

## States  (Стани)
<Every state the user can see: normal, empty, loading, error, edge cases.>

## Non-goals  (Не робить)
<What this area deliberately does not do.>

## Open questions  (Відкриті питання)
<Anything unclear from the code. "None" if fully understood.>
```

Requirements use the same `### Requirement:` / `#### Scenario:` shape the delta uses, so the change's ADDED / MODIFIED / REMOVED sections can later be merged into this file requirement by requirement.

_Adapted from the team's own `eclipt-skills/product/document-project` (descriptive docs) and the requirement / scenario shape of OpenSpec (Fission-AI/OpenSpec, MIT)._
