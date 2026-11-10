import { describe, expect, it } from 'vitest';

import { FACTORY_REF_MIME, parseRefs, readDraggedRef, serializeRefs, withRef, writeDraggedRef } from './factoryRefs';
import type { FactoryRef } from './factoryRefs';

const CARD: FactoryRef = {
  kind: 'card',
  sessionId: 'session-1',
  threadId: 'session-1',
  workItemId: 'card-1',
  title: 'Loyalty',
  board: 'product',
};
const SESSION: FactoryRef = { kind: 'session', sessionId: 'session-2', title: 'Inbox' };

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
    expect(JSON.parse(drag.data.get(FACTORY_REF_MIME)!)).toEqual(CARD);
    expect(drag.data.get('text/plain')).toBe('Loyalty');
    expect(drag.effectAllowed).toBe('copy');
    expect(readDraggedRef(drag)).toEqual(CARD);
  });

  it('ignore a drag that is not a Factory row, or a malformed one', () => {
    expect(readDraggedRef({ getData: () => '' })).toBeUndefined();
    expect(readDraggedRef({ getData: () => '{oops' })).toBeUndefined();
    expect(readDraggedRef({ getData: () => JSON.stringify({ kind: 'thread', sessionId: 'x', title: 'y' }) })).toBeUndefined();
  });

  it('are added once', () => {
    expect(withRef(withRef([], CARD), { ...CARD })).toEqual([CARD]);
  });

  it('serialize after the text as a fenced block, one line each, and parse back', () => {
    const sent = serializeRefs('Look at these', [CARD, SESSION]);
    expect(sent).toBe(
      'Look at these\n\n```factory-refs\n' +
        '{"kind":"card","sessionId":"session-1","threadId":"session-1","workItemId":"card-1","title":"Loyalty","board":"product"}\n' +
        '{"kind":"session","sessionId":"session-2","title":"Inbox"}\n```',
    );
    expect(parseRefs(sent)).toEqual({ body: 'Look at these', refs: [CARD, SESSION] });
    expect(parseRefs(serializeRefs('', [SESSION]))).toEqual({ body: '', refs: [SESSION] });
  });

  it('leave a message without a block, or with a malformed one, as written', () => {
    expect(serializeRefs('Hi', [])).toBe('Hi');
    expect(parseRefs('Hi')).toEqual({ body: 'Hi', refs: [] });
    const broken = 'Hi\n\n```factory-refs\nnot json\n```';
    expect(parseRefs(broken)).toEqual({ body: broken, refs: [] });
  });
});
