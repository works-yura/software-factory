import { describe, expect, it } from 'vitest';

import { errorText } from '../errorText';

describe('errorText', () => {
  it("reads an Error's message", () => {
    expect(errorText(new Error('Organization not found'))).toBe('Organization not found');
  });

  it('shows anything else as it is', () => {
    expect(errorText('offline')).toBe('offline');
    expect(errorText(404)).toBe('404');
  });
});
