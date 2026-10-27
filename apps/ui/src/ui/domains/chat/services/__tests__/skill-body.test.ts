import { describe, expect, it } from 'vitest';

import { parseSkillBody } from '../skill-body';

describe('parseSkillBody', () => {
  it('parses skill signal contents with arguments and a trailing work-item feed', () => {
    const text =
      'Look at the issue.\n\nARGUMENTS: Issue 42\n\n<work-item-feed>\n[Bob · now]\nship it\n</work-item-feed>';
    expect(parseSkillBody('triage-issue', text)).toEqual({
      name: 'triage-issue',
      instructions: 'Look at the issue.',
      arguments: 'Issue 42',
      feed: '[Bob · now]\nship it',
    });
  });

  it('keeps the whole body as instructions when there are no arguments or feed', () => {
    expect(parseSkillBody('understand-issue', 'Investigate.\n\n## References\n- references/a.md')).toEqual({
      name: 'understand-issue',
      instructions: 'Investigate.\n\n## References\n- references/a.md',
      arguments: undefined,
    });
  });

  it('returns undefined for an empty body or missing name', () => {
    expect(parseSkillBody('understand-issue', '  ')).toBeUndefined();
    expect(parseSkillBody('', 'Investigate.')).toBeUndefined();
  });
});
