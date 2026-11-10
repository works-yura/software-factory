// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadText } from '../downloadText';

describe('downloadText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the text under the given name with its type, and releases the object URL', async () => {
    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(value => {
      blob = value as Blob;
      return 'blob:download';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('requirements.md');
      expect(this.href).toBe('blob:download');
    });

    downloadText('requirements.md', '# Brief', 'text/markdown');

    expect(click).toHaveBeenCalledOnce();
    expect(blob?.type).toBe('text/markdown;charset=utf-8');
    expect(await blob?.text()).toBe('# Brief');
    expect(revoke).toHaveBeenCalledWith('blob:download');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
