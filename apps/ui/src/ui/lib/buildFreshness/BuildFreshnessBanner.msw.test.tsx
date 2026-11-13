import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BuildFreshness } from './buildFreshness';
import { BuildFreshnessBanner } from './BuildFreshnessBanner';

const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: () => {}, removeEventListener: () => {} };

describe('BuildFreshnessBanner', () => {
  it('shows nothing while the page runs the served build, then asks for a reload once a new one is live', async () => {
    let entry = '/assets/index-old.js';
    const freshness = new BuildFreshness({
      loaded: '/assets/index-old.js',
      fetchIndex: async () => `<script type="module" src="${entry}"></script>`,
      doc,
    });
    const reload = vi.fn();
    render(<BuildFreshnessBanner freshness={freshness} reload={reload} />);
    await freshness.checkNow();
    expect(screen.queryByRole('status')).toBeNull();

    entry = '/assets/index-new.js';
    await freshness.checkNow();
    const button = await screen.findByRole('button');
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.click(button);
    expect(reload).toHaveBeenCalledOnce();
    freshness.dispose();
  });
});
