import { describe, expect, it } from 'vitest';

import { passageLines, passageLink } from '../passage-lines';

const DOC = [
  '# Сповіщення', // 1
  '', // 2
  'Вступ до брифу.', // 3
  '', // 4
  '## Polar', // 5
  '', // 6
  '1. Оплата не пройшла — **надіслати** лист.', // 7
  '2. Дивись [документацію](https://polar.sh/docs) для деталей.', // 8
  '', // 9
  '```ts', // 10
  'const retry = 3;', // 11
  '```', // 12
  '', // 13
  '- [ ] Повторити спробу', // 14
  '- Оплата не пройшла', // 15
].join('\n');

describe('passageLines', () => {
  it('finds the lines of a passage selected in the rendered document', () => {
    expect(passageLines(DOC, 'Вступ до брифу.')).toEqual({ start: 3, end: 3 });
    expect(passageLines(DOC, 'Оплата не пройшла — надіслати лист.\nДивись документацію для деталей.')).toEqual({
      start: 7,
      end: 8,
    });
  });

  it('ignores heading marks, list numbers, link targets and fence lines', () => {
    expect(passageLines(DOC, 'Polar\nОплата')).toEqual({ start: 5, end: 7 });
    expect(passageLines(DOC, 'деталей.\nconst retry = 3;\nПовторити спробу')).toEqual({ start: 8, end: 14 });
  });

  it('tells repeated text apart by what came before it', () => {
    expect(passageLines(DOC, 'Оплата не пройшла')).toEqual({ start: 7, end: 7 });
    expect(passageLines(DOC, 'Оплата не пройшла', 'спробу')).toEqual({ start: 15, end: 15 });
  });

  it('places a passage the renderer added text to by its first and last words', () => {
    expect(
      passageLines(DOC, 'Дивись документацію для деталей.\nts\nCopy\nconst retry = 3;\nПовторити спробу'),
    ).toEqual({ start: 8, end: 14 });
  });

  it('gives up on text that is not in the file', () => {
    expect(passageLines(DOC, 'Цього тексту немає')).toBeUndefined();
    expect(passageLines(DOC, '— …')).toBeUndefined();
  });
});

describe('passageLink', () => {
  it('links the file and its lines', () => {
    expect(passageLink('docs/changes/x/requirements.md', { start: 262, end: 275 })).toBe(
      '[docs/changes/x/requirements.md:262-275](docs/changes/x/requirements.md#L262-L275)',
    );
    expect(passageLink('a b.md', { start: 4, end: 4 })).toBe('[a b.md:4](a%20b.md#L4)');
    expect(passageLink('a.md', undefined)).toBe('[a.md](a.md)');
  });
});
