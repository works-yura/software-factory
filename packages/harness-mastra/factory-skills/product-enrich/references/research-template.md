# research.md template

Path: `<docs>/changes/<change>/research.md`. Write it in the person's language. Keep these headings (or the Ukrainian ones in brackets) so `factory_check_product_document` (`type: enrich`) recognises them. Write `None` rather than leaving a section empty.

````markdown
# <Feature>: research

Card: <link> · <date> · Interviewed: <who> · Rounds: <n>

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

## Reuse  (Повторне використання)
What already exists that this feature reuses or extends, with links. `None` if greenfield.

## How the engineer would build it  (Як би зробив інженер)
- …

## Glossary changes  (Зміни в глосарії)
Terms added or sharpened in GLOSSARY.md during the interview.

## Open questions  (Відкриті питання)
- <question> — who answers it — what it blocks
````
