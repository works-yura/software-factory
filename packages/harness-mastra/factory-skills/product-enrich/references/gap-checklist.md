# Behaviour gap checklist

Shared by the Product skills. **Research runs it before declaring the frontier empty**; Brief and Spec re-run it only as a self-check. Read it with `skill_read`, skill `product-enrich`, file `references/gap-checklist.md`.

For every item of the request, walk each line below against the code and the documents. A line that does not apply is skipped silently. A line that applies and the code or documents settle is a **fact** for your summary. A line that applies and is **the person's call** (behaviour, scope, who gets what, money, timing) is a **question** in the next round, through the question tool, with options and your recommended answer first. Never park such a line as a pitfall, an open question or "decide in Spec": that is how a person's decision gets skipped.

## Who and what

- **Actor and ownership changes.** The thing changes hands after it was created: a booking reassigned to another master, transferred to another location, a chat taken over by a person, an owner replaced. Who is told, who loses access, what the old owner sees.
- **Who triggered it.** The same event from the client, from the business, from an agent or from the system (a job, an expiry). Does that change who is told, what the text says, whether the actor is told about their own action.
- **Several tenants.** One person in several businesses, locations or teams; a role that differs per business (admin here, staff there); settings per person or per person-per-business; what a person sees when switching.
- **Roles and permissions.** Owner, admin, staff, a client without an account; who may see money (deposits, prices), who may change settings for others.

## States and time

- **Account and object states.** The business is paused, unpaid, in trial, cancelled or deleted; a location closed; a staff member deactivated; an object archived. What happens to this feature in each.
- **Existing data and settings.** What existing users, records and settings become when this ships: migrated, defaulted, left alone; what an existing user sees on the first day.
- **Second time, empty, failure, retry.** The second occurrence (already sent? merged?), nothing to show, the provider or network failing, a retry producing a duplicate, a partial success.
- **Timing.** Quiet hours, time zones (business vs person vs client), scheduled vs immediate, ordering when events arrive close together, expiry and reminders.

## Words and edges

- **Language.** The language of every message, screen and email the user receives (the person's, the business's, the client's); who writes and approves the texts.
- **Out-of-scope neighbours.** Things next to the ask a reader might assume are included (another channel, another event type, a report on top of it): name each, in or out, so nobody discovers it at acceptance.
- **Fit with the literal request.** Each item as the client wrote it: does the planned behaviour deliver exactly that, or does it replace, drop or add something? A difference is a question.

Brief keeps its own steps for what is legitimately the brief's: **external dependencies** (provider reviews, access such as DNS, accounts) and **running costs** (who pays, tiers). Those are not behaviour gaps and are not asked in Research unless the person raises them.
