import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sparkline } from './sparkline';

describe('Sparkline', () => {
  it('draws a line and its fill through every value, scaled to the largest', () => {
    const html = renderToStaticMarkup(<Sparkline values={[0, 2, 4]} color="red" />);
    // 32-high box, 2px padding: 0 sits on the floor, the max on the ceiling.
    expect(html).toContain('d="M 0,30 L 50,16 L 100,2"');
    expect(html).toContain('stroke="red"');
  });

  it('marks the last value with a dot', () => {
    const html = renderToStaticMarkup(<Sparkline values={[4, 0]} color="red" />);
    expect(html).toContain('left:100%;top:93.75%');
  });

  it('draws nothing for fewer than two values', () => {
    expect(renderToStaticMarkup(<Sparkline values={[3]} color="red" />)).toBe('');
  });

  it('draws a dashed outline as a placeholder', () => {
    const html = renderToStaticMarkup(<Sparkline values={[]} color="red" placeholder />);
    expect(html).toContain('data-slot="sparkline-placeholder"');
    expect(html).toContain('stroke-dasharray="4 4"');
  });
});
