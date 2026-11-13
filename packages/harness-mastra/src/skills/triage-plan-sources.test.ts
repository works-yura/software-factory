import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const skillsDir = join(__dirname, '..', '..', 'factory-skills');
const readSkill = (skill: string) => readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8');

// Upstream's Jira, incident.io and GitLab source cases are not ported: v4 triages Factory cards only.
describe('factory-triage approval routing', () => {
  const content = readSkill('factory-triage');

  it('returns pending approval cards in Triage to Intake without clearing their label', () => {
    const awaitingApproval = content.split('**Awaiting approval:**')[1]?.split('\n\n')[0];
    expect(awaitingApproval).toContain('For a card in `triage`');
    expect(awaitingApproval).toContain('When prior acceptance is not established');
    expect(awaitingApproval).toContain("If `rest` appears in the `factory-phase` signal's `Next phases`");
    expect(awaitingApproval).toContain('request a transition to `rest`');
    expect(awaitingApproval).toContain(
      'If `rest` is not in `Next phases`, report that the board must allow a transition',
    );
    expect(awaitingApproval).toContain('do not request an invalid transition or change the label');
    expect(awaitingApproval).toContain('retain `status: needs approval`');
    expect(awaitingApproval).toContain(
      'If the card is not in `triage`, stop without changing labels or requesting a transition',
    );
    expect(awaitingApproval).toContain(
      'If the handoff or its `Type` is missing, state that in the rationale without inventing a `Type`',
    );
  });

  it('does not mistake a stale approval label for a new approval request after a human accepts the work', () => {
    const awaitingApproval = content.split('**Awaiting approval:**')[1]?.split('\n\n')[0];
    expect(awaitingApproval).toContain('factory_inspect_work_item');
    expect(awaitingApproval).toContain('stage history');
    expect(awaitingApproval).toContain('human');
    expect(awaitingApproval).toContain('human `stage_moved` audit event');
    expect(awaitingApproval).toContain('not a provider/webhook event');
    expect(awaitingApproval).toContain('most recent approval handoff');
    expect(awaitingApproval).toContain('stale');
    expect(awaitingApproval).toContain('do not return it to `rest` for a second approval');
    expect(awaitingApproval).toContain('When prior acceptance is not established');
    expect(content).toContain('For previously approved open work, use `Route: Plan fix`');
    expect(content).toContain('if none is in `Next phases`, report the missing board transition');
  });

  it('lets explicit board Planning routes apply to all authors, including untrusted authors', () => {
    const routing = content
      .split('**A board that waives the approval wait:**')[1]
      ?.split('\n- When the item is already past triage')[0];
    expect(routing).toContain('explicit routing criteria');
    expect(routing).toContain('`effort:low` or `effort:medium`');
    expect(routing).toContain('regardless of author trust');
    expect(routing).toContain('takes precedence over the default `rest` route');
    expect(routing).not.toContain('Everything else still rests: an untrusted author');
  });
});
