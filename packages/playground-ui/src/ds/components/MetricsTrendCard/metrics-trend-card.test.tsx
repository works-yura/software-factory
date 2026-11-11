// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsReadout, MetricsTrendCard, morphView } from './metrics-trend-card';

afterEach(() => {
  cleanup();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

function Harness({ empty = false }: { empty?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <dl>
      <MetricsTrendCard
        icon={null}
        label="Completed"
        value="12"
        detail="0.4 per day"
        values={[1, 3, 2]}
        color="red"
        empty={empty}
        expanded={expanded}
        onExpandedChange={setExpanded}
        toggleLabel={`Completed: 12. ${expanded ? 'Hide' : 'Show'} the chart`}
        chartCaption="Daily completions over 30 days"
      >
        <div>full chart</div>
      </MetricsTrendCard>
    </dl>
  );
}

describe('MetricsTrendCard', () => {
  it('grows from its preview into the full chart and back', () => {
    const { container } = render(<Harness />);
    expect(screen.queryByText('full chart')).toBeNull();
    expect(container.querySelector('[data-slot="sparkline"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Completed: 12. Show the chart' }));

    expect(screen.getByText('full chart')).toBeTruthy();
    expect(screen.getByText('Daily completions over 30 days')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Completed: 12. Hide the chart' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
    expect(container.querySelector('[data-slot="sparkline"]')).toBeNull();
    expect(container.querySelector('[data-slot="metrics-trend-card"]')!.className).toContain('col-span-full');

    fireEvent.click(toggle);
    expect(screen.queryByText('full chart')).toBeNull();
  });

  it('draws a dashed outline when there is nothing to plot yet', () => {
    const { container } = render(<Harness empty />);
    expect(container.querySelector('[data-slot="sparkline-placeholder"]')).not.toBeNull();
  });

  it('names its own view transition', () => {
    const { container } = render(<Harness />);
    const card = container.querySelector<HTMLElement>('[data-slot="metrics-trend-card"]')!;
    expect(card.style.getPropertyValue('view-transition-name')).toMatch(/^metrics-trend-[\w-]+$/);
  });
});

describe('MetricsReadout', () => {
  it('reads its label, value and detail', () => {
    render(
      <dl>
        <MetricsReadout icon={null} label="In flight" value="4" detail="2 agents running" />
      </dl>,
    );
    expect(screen.getByText('In flight')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('2 agents running')).toBeTruthy();
  });
});

describe('morphView', () => {
  it('applies the change directly without the View Transition API', () => {
    const update = vi.fn();
    morphView(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('runs the change inside a view transition when the browser has one', () => {
    const update = vi.fn();
    const start = vi.fn((callback: () => void) => {
      callback();
      return { ready: Promise.resolve() };
    });
    (document as { startViewTransition?: unknown }).startViewTransition = start;
    morphView(update);
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
