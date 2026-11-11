import { describe, expect, it } from 'vitest';

import { elicitationQuestions, elicitationResponse, splitQuestionAnswers } from './elicitation.ts';

/** A card's answers as the chat sends them: each under its numbered question. */
const chatReply = (pairs: Array<[string, string]>) => pairs.map(([question, answer], index) => `${index + 1}. ${question}\n   → ${answer}`).join('\n');

describe('MCP elicitations as question cards', () => {
  const form = {
    serverName: 'deploy',
    mode: 'form',
    message: 'Where should it deploy?',
    requestedSchema: {
      type: 'object',
      properties: {
        env: { type: 'string', title: 'Environment', oneOf: [{ const: 'staging', title: 'Staging' }, { const: 'prod', title: 'Production' }], default: 'prod' },
        confirm: { type: 'boolean', title: 'Notify', description: 'Tell the channel?' },
        replicas: { type: 'integer', title: 'Replicas' },
        regions: { type: 'array', title: 'Regions', items: { type: 'string', enum: ['eu', 'us'] } },
        note: { type: 'string', title: 'Note' },
      },
      required: ['env', 'replicas'],
    },
  };

  it('asks every field as a question: choices for enums and booleans, the default first and recommended', () => {
    const card = elicitationQuestions(form)!;
    expect(card.input.questions).toEqual([
      { id: 'env', header: 'Environment', question: 'Where should it deploy?\n\nEnvironment', options: [{ label: 'Production (Recommended)' }, { label: 'Staging' }] },
      { id: 'confirm', header: 'Notify', question: 'Tell the channel?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'replicas', header: 'Replicas', question: 'Replicas' },
      { id: 'regions', header: 'Regions', question: 'Regions', options: [{ label: 'eu' }, { label: 'us' }], multiSelect: true },
      { id: 'note', header: 'Note', question: 'Note' },
    ]);
  });

  it('reads the answers back into typed content', () => {
    const card = elicitationQuestions(form)!;
    const questions = card.input.questions.map(question => question.question as string);
    const reply = chatReply([
      [questions[0]!, 'Staging'],
      [questions[1]!, 'Yes'],
      [questions[2]!, '3'],
      [questions[3]!, 'eu; us'],
      [questions[4]!, 'ship it\nafter lunch'],
    ]);
    expect(elicitationResponse(card.plan, reply)).toEqual({
      action: 'accept',
      content: { env: 'staging', confirm: true, replicas: 3, regions: ['eu', 'us'], note: 'ship it\nafter lunch' },
    });
    // A required field left without an answer declines the form.
    const missing = chatReply([
      [questions[0]!, 'Production (Recommended)'],
      [questions[1]!, ''],
      [questions[2]!, 'many'],
      [questions[3]!, ''],
      [questions[4]!, ''],
    ]);
    expect(elicitationResponse(card.plan, missing)).toEqual({ action: 'decline' });
  });

  it('asks a link as Done or Decline, and a form without fields as a confirmation', () => {
    const link = elicitationQuestions({ serverName: 'gh', mode: 'url', message: 'Sign in to GitHub', url: 'https://github.com/login/device', elicitationId: 'e1' })!;
    expect(link.input.questions[0]).toMatchObject({ question: 'Sign in to GitHub\n\nhttps://github.com/login/device', options: [{ label: 'Done' }, { label: 'Decline' }] });
    expect(elicitationResponse(link.plan, 'Done')).toEqual({ action: 'accept' });
    expect(elicitationResponse(link.plan, 'Decline')).toEqual({ action: 'decline' });

    const confirm = elicitationQuestions({ serverName: 'x', mode: 'form', message: 'Proceed?', requestedSchema: { type: 'object', properties: {} } })!;
    expect(elicitationResponse(confirm.plan, 'Accept')).toEqual({ action: 'accept', content: {} });

    expect(elicitationQuestions({ serverName: 'x', mode: 'openai/userVerification', message: 'Verify' })).toBeUndefined();
  });

  it('splits one reply to several questions back into each answer', () => {
    expect(splitQuestionAnswers(['A?', 'B?'], chatReply([['A?', 'one'], ['B?', 'two']]))).toEqual(['one', 'two']);
    // Anything else goes to every question whole.
    expect(splitQuestionAnswers(['A?', 'B?'], 'both the same')).toEqual(['both the same', 'both the same']);
    expect(splitQuestionAnswers(['A?'], ' only ')).toEqual(['only']);
  });
});
