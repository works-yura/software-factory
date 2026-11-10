# research.md template

Path: `<docs>/changes/<change>/research.md`. Write it in the person's language. Keep these headings (or the Ukrainian ones in brackets) so `factory_check_product_document` (`type: enrich`) recognises them. Write `None` rather than leaving a section empty.

````markdown
# <Feature>: research

Card: <link> · <date> · Interviewed: <who> · Rounds: <n>

## Change and areas  (Зміна й області)
Change folder `changes/<change>`; areas `features/<area>` it touches (new areas need a baseline in Spec); the documentation folder used and why.

## Intent  (Наміри замовника)
What happened, why now; what the client expects, quoted from the request (with its source); how the client will know it works.

## Priorities  (Пріоритети)
| Item | Must / Should / Could / Won't | Why |
|---|---|---|

## How the system works today  (Як працює система зараз)
What this touches today, in the engineer's words, with file paths and the documents that describe it.

## Pitfalls  (Підводні камені)
- <pitfall> — where it bites, and what the engineer said to do about it

## Constraints  (Обмеження)
- <platform, deadline, compliance, performance, budget, paid service…>

## Decisions  (Рішення)
The design tree as it was settled, one line per decision, in the order it was taken.
| # | Decision | Chosen | Why | Record |
|---|---|---|---|---|
| Q1 | <question> | <answer> | <reason> | <proposed DEC-nnn / adr/000N-… / —> |

## Related changes  (Пов'язані зміни)
<!-- Required, never dropped. From factory_list_product_changes + factory_read_product_change. Decisions taken from these cards are used, not re-asked. -->
| Card | Status | What it decided that this change relies on | Direction |
|---|---|---|---|
| <«Сповіщення #1–9», client-review, changes/2026-11-10-notifications-channels> | рішення в роботі (not approved) | <web push from the admin app, no store apps; email via Resend> | <this change builds on it (#24 is sent through it)> |

Or: `None found — checked <N> cards.`

## Reuse  (Повторне використання)
What already exists that this feature reuses or extends, with links. `None` if greenfield.

## How the engineer would build it  (Як би зробив інженер)
- …

## Glossary changes  (Зміни в глосарії)
Terms added or sharpened in GLOSSARY.md during the interview.

## Deferred to Spec  (Відкладено на специфікацію)
Technical choices only (storage shape, a provider API detail), each with why it is technical. `None` if none. A behaviour, scope or money point never goes here: it is asked.

## Open questions  (Відкриті питання)
Only what neither the person nor the code can answer (usually the client's), each: <question> — who answers it — what it blocks. `None` if none.
````
