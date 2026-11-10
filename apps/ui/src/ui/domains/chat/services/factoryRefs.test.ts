import { afterEach, describe, expect, it } from 'vitest';

import { FACTORY_REF_MIME, parseRefs, readDraggedRef, serializeRefs, withRef, writeDraggedRef } from './factoryRefs';
import type { FactoryRef } from './factoryRefs';
import { CARD_REF_KIND, REF_KINDS, defineRefKind, refKind, removeRefKind } from './refKinds';

const CARD: FactoryRef = {
  kind: 'card',
  title: 'Loyalty',
  fields: { sessionId: 'session-1', threadId: 'session-1', workItemId: 'card-1', board: 'product' },
};
const SESSION: FactoryRef = { kind: 'session', title: 'Inbox', fields: { sessionId: 'session-2' } };

function transfer() {
  const data = new Map<string, string>();
  return {
    data,
    effectAllowed: 'all',
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  };
}

describe('factory references', () => {
  it('travel on a drag as the typed payload and the title as text', () => {
    const drag = transfer();
    writeDraggedRef(drag, CARD);
    expect(JSON.parse(drag.data.get(FACTORY_REF_MIME)!)).toEqual({ kind: 'card', title: 'Loyalty', ...CARD.fields });
    expect(drag.data.get('text/plain')).toBe('Loyalty');
    expect(drag.effectAllowed).toBe('copy');
    expect(readDraggedRef(drag)).toEqual(CARD);
  });

  it('ignore a drag that is not a Factory row, an unknown kind, or a malformed one', () => {
    expect(readDraggedRef({ getData: () => '' })).toBeUndefined();
    expect(readDraggedRef({ getData: () => '{oops' })).toBeUndefined();
    expect(readDraggedRef({ getData: () => JSON.stringify({ kind: 'thread', sessionId: 'x', title: 'y' }) })).toBeUndefined();
    expect(readDraggedRef({ getData: () => JSON.stringify({ kind: 'card', title: 'No session' }) })).toBeUndefined();
  });

  it('are added once', () => {
    expect(withRef(withRef([], CARD), { ...CARD, fields: { ...CARD.fields } })).toEqual([CARD]);
  });

  it('serialize after the text as a fenced block, one line each, and parse back', () => {
    const sent = serializeRefs('Look at these', [CARD, SESSION]);
    expect(sent).toBe(
      'Look at these\n\n```factory-refs\n' +
        '{"kind":"card","title":"Loyalty","sessionId":"session-1","threadId":"session-1","workItemId":"card-1","board":"product"}\n' +
        '{"kind":"session","title":"Inbox","sessionId":"session-2"}\n```',
    );
    expect(parseRefs(sent)).toEqual({ body: 'Look at these', refs: [CARD, SESSION] });
    expect(parseRefs(serializeRefs('', [SESSION]))).toEqual({ body: '', refs: [SESSION] });
  });

  it('read blocks sent before references had a kind registry', () => {
    const old =
      'Hi\n\n```factory-refs\n' +
      '{"kind":"card","sessionId":"session-1","threadId":"session-1","workItemId":"card-1","title":"Loyalty","board":"product"}\n```';
    expect(parseRefs(old)).toEqual({ body: 'Hi', refs: [CARD] });
  });

  it('keep a reference of an unknown kind with its fields, rather than dropping it', () => {
    const sent = 'See\n\n```factory-refs\n{"kind":"pull-request","title":"#42","number":"42","repo":"acme/app"}\n```';
    expect(parseRefs(sent)).toEqual({
      body: 'See',
      refs: [{ kind: 'pull-request', title: '#42', fields: { number: '42', repo: 'acme/app' } }],
    });
  });

  it('leave a message without a block, or with a malformed one, as written', () => {
    expect(serializeRefs('Hi', [])).toBe('Hi');
    expect(parseRefs('Hi')).toEqual({ body: 'Hi', refs: [] });
    const broken = 'Hi\n\n```factory-refs\nnot json\n```';
    expect(parseRefs(broken)).toEqual({ body: broken, refs: [] });
  });
});

describe('reference kinds', () => {
  afterEach(() => removeRefKind('doc'));

  it('come with the session and card kinds', () => {
    expect([...REF_KINDS.keys()]).toEqual(expect.arrayContaining(['session', 'card']));
    expect(CARD_REF_KIND.href?.(CARD, { factoryId: 'f-1' })).toBe('/factories/f-1/workspaces/session-1/threads/session-1');
  });

  it('a newly defined kind is read with only its own fields and needs its required ones', () => {
    defineRefKind({
      kind: 'doc',
      required: ['path'],
      icon: () => null,
      subtitle: () => 'Document',
      href: ref => `/docs/${ref.fields.path}`,
    });
    expect(refKind('doc')).toBeDefined();
    const drag = transfer();
    writeDraggedRef(drag, { kind: 'doc', title: 'Brief', fields: { path: 'brief.md' } });
    expect(readDraggedRef(drag)).toEqual({ kind: 'doc', title: 'Brief', fields: { path: 'brief.md' } });
    expect(
      parseRefs('```factory-refs\n{"kind":"doc","title":"Brief","path":"brief.md","extra":"x"}\n```').refs,
    ).toEqual([{ kind: 'doc', title: 'Brief', fields: { path: 'brief.md' } }]);
    expect(readDraggedRef({ getData: () => JSON.stringify({ kind: 'doc', title: 'No path' }) })).toBeUndefined();
  });
});
