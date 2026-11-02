import { afterEach, describe, expect, it } from 'vitest';
import { libText } from './lib-text';
import { viewDisplayName } from '@/ds/components/SavedViews/use-saved-views';

type Host = { __factoryLibT?: (text: string) => string };

afterEach(() => {
  delete (globalThis as Host).__factoryLibT;
});

describe('libText', () => {
  it('returns the English text when the host registers no translator', () => {
    expect(libText('Cancel')).toBe('Cancel');
  });

  it('routes the text through the host translator', () => {
    (globalThis as Host).__factoryLibT = text => (text === 'Cancel' ? 'Скасувати' : text);

    expect(libText('Cancel')).toBe('Скасувати');
    expect(libText('Save')).toBe('Save');
  });

  it('falls back to the English text when the translator has no answer', () => {
    (globalThis as Host).__factoryLibT = () => undefined as unknown as string;

    expect(libText('Cancel')).toBe('Cancel');
  });

  it('translates the default saved-view name for display but leaves user names alone', () => {
    (globalThis as Host).__factoryLibT = text => (text === 'Untitled view' ? 'Без назви' : text);

    expect(viewDisplayName('Untitled view')).toBe('Без назви');
    expect(viewDisplayName('My view')).toBe('My view');
  });
});
