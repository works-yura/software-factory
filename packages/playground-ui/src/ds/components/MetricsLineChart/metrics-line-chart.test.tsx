// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsLineChart } from './metrics-line-chart';
import type { MetricsLineChartSeries } from './metrics-line-chart';

class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const entry = { target, contentRect: { width: 640, height: 260 } } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(260);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(260);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 640,
    bottom: 260,
    width: 640,
    height: 260,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const data = [
  { time: 'Mon', done: 1, other: 2 },
  { time: 'Tue', done: 3, other: 1 },
  { time: 'Wed', done: 2, other: 4 },
];
const one: MetricsLineChartSeries[] = [{ dataKey: 'done', label: 'Done', color: 'var(--chart-green)' }];
const two: MetricsLineChartSeries[] = [...one, { dataKey: 'other', label: 'Other', color: 'var(--chart-blue)' }];

describe('MetricsLineChart fill', () => {
  it('paints a soft wash by default, with no halo', async () => {
    const { container } = render(<MetricsLineChart data={data} series={one} height={260} showLegend={false} />);
    await waitFor(() => expect(container.querySelector('.recharts-area')).not.toBeNull());
    expect(container.querySelector('filter')).toBeNull();
    expect(container.querySelector('.metrics-line-glow')).toBeNull();
    const stops = container.querySelectorAll('linearGradient stop');
    expect(stops).toHaveLength(2);
    expect(stops[0]?.getAttribute('stop-opacity')).toBe('0.12');
  });

  it('glows: a token-driven gradient and a blurred halo under each line', async () => {
    const { container } = render(
      <MetricsLineChart data={data} series={one} height={260} showLegend={false} fill="glow" />,
    );
    await waitFor(() => expect(container.querySelector('.metrics-line-glow')).not.toBeNull());
    const filter = container.querySelector('filter');
    expect(filter?.querySelector('feGaussianBlur')).not.toBeNull();
    expect(container.querySelector('.metrics-line-glow path')?.getAttribute('filter')).toBe(`url(#${filter?.id})`);
    const stops = container.querySelectorAll('linearGradient stop');
    expect(stops).toHaveLength(3);
    expect((stops[0] as SVGStopElement).style.stopOpacity).toBe('var(--chart-area-top)');
  });

  it('stacks areas without a halo', async () => {
    const { container } = render(
      <MetricsLineChart data={data} series={two} height={260} showLegend={false} fill="glow" stacked />,
    );
    await waitFor(() => expect(container.querySelectorAll('.recharts-area')).toHaveLength(2));
    expect(container.querySelector('.metrics-line-glow')).toBeNull();
    expect(container.querySelectorAll('linearGradient stop')).toHaveLength(6);
  });
});
