// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/ds/components/Tooltip';
import { foldShareBarSlices, ShareBar } from './share-bar';
import type { ShareBarSlice } from './share-bar';

afterEach(cleanup);

const slice = (key: string, value: number, extra: Partial<ShareBarSlice> = {}): ShareBarSlice => ({
  key,
  label: key.toUpperCase(),
  value,
  color: `bg-${key}`,
  ...extra,
});

function renderBar(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('ShareBar', () => {
  it('names each segment with its amount and share', () => {
    renderBar(<ShareBar slices={[slice('a', 3), slice('b', 1)]} formatAmount={value => `${value} items`} />);
    expect(screen.getByRole('img', { name: 'A: 3 items, 75%' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'B: 1 items, 25%' })).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('prints the value and its detail in the legend', () => {
    renderBar(<ShareBar slices={[slice('a', 1200, { detail: '≈ $2.50' })]} formatValue={value => `${value / 1000}K`} />);
    expect(screen.getByText('1.2K')).toBeTruthy();
    expect(screen.getByText('≈ $2.50')).toBeTruthy();
  });

  it('draws nothing when the whole is zero', () => {
    const { container } = renderBar(<ShareBar slices={[slice('a', 0)]} />);
    expect(container.querySelector('[data-slot="share-bar"]')).toBeNull();
  });

  it('dims the other slices while one is hovered', () => {
    renderBar(<ShareBar slices={[slice('a', 3), slice('b', 1)]} />);
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'A: 3, 75%' }));
    expect(screen.getByRole('img', { name: 'A: 3, 75%' }).className).toContain('opacity-100');
    expect(screen.getByRole('img', { name: 'B: 1, 25%' }).className).toContain('opacity-25');
  });

  it('folds the tail into Other, and opens the legend up to every slice', () => {
    renderBar(<ShareBar slices={[slice('a', 5), slice('b', 3), slice('c', 1), slice('d', 1)]} limit={2} />);
    expect(screen.getByRole('img', { name: 'Other: 2, 20%' })).toBeTruthy();
    expect(screen.queryByText('C')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getByText('C')).toBeTruthy();
    expect(screen.getByText('D')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('foldShareBarSlices', () => {
  it('keeps a short list as it is', () => {
    const slices = [slice('a', 1)];
    expect(foldShareBarSlices(slices, 3, 'Other')).toBe(slices);
  });

  it('sums the rest into one quiet slice', () => {
    const folded = foldShareBarSlices([slice('a', 5), slice('b', 3), slice('c', 2)], 1, 'Other');
    expect(folded.map(entry => [entry.label, entry.value, entry.color])).toEqual([
      ['A', 5, 'bg-a'],
      ['Other', 5, 'bg-chart-share-rest'],
    ]);
  });
});
