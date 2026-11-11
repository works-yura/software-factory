// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageLimitBar, UsageLimitRing, UsageLimitRow } from './usage-limit';
import { usageLimitLevel } from './usage-limit-level';

afterEach(cleanup);

describe('usageLimitLevel', () => {
  it('reads amber from 80 % and red from 95 %', () => {
    expect(usageLimitLevel(79.9)).toBe('ok');
    expect(usageLimitLevel(80)).toBe('warning');
    expect(usageLimitLevel(94)).toBe('warning');
    expect(usageLimitLevel(95)).toBe('critical');
    expect(usageLimitLevel(100)).toBe('critical');
  });
});

describe('UsageLimit', () => {
  it('speaks a bar as a meter with its level', () => {
    render(<UsageLimitBar label="Weekly" percent={82.4} />);
    const meter = screen.getByRole('meter', { name: 'Weekly' });
    expect(meter.getAttribute('aria-valuenow')).toBe('82');
    expect(meter.getAttribute('aria-valuetext')).toBe('82%');
    expect(meter.dataset.level).toBe('warning');
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('82.4%');
  });

  it('clamps past the limit and draws no fill when nothing is used', () => {
    render(<UsageLimitBar label="Over" percent={140} />);
    expect(screen.getByRole('meter', { name: 'Over' }).dataset.level).toBe('critical');
    render(<UsageLimitBar label="Empty" percent={0} />);
    expect(screen.getByRole('meter', { name: 'Empty' }).firstElementChild).toBeNull();
  });

  it('prints a ring’s reading beside it, in the level’s ink', () => {
    render(
      <UsageLimitRing label="5-hour" percent={97} valueText="97% used, resets in 1h">
        97%
      </UsageLimitRing>,
    );
    const ring = screen.getByRole('meter', { name: '5-hour' });
    expect(ring.getAttribute('aria-valuetext')).toBe('97% used, resets in 1h');
    expect(ring.className).toContain('text-destructive-foreground');
    expect(ring.textContent).toBe('97%');
  });

  it('lays a row out as name, bar, value and detail', () => {
    render(<UsageLimitRow label="Weekly · Opus" percent={12} value="12%" detail="resets in 2d 4h" />);
    expect(screen.getByText('Weekly · Opus')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Weekly · Opus' }).dataset.level).toBe('ok');
    expect(screen.getByText('12%')).toBeTruthy();
    expect(screen.getByText('resets in 2d 4h')).toBeTruthy();
  });
});
