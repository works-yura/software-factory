import { useId } from 'react';
import { cn } from '@/lib/utils';

const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 32;
const PADDING = 2;

export type SparklineProps = {
  values: number[];
  /** Any CSS color, e.g. `var(--chart-green)`. */
  color: string;
  className?: string;
  /**
   * A dashed, flat outline in place of the line: the shape the trend will take, without inventing
   * values. Drawn for a series that has nothing to plot yet.
   */
  placeholder?: boolean;
};

/**
 * A small trend line with a soft fill and a dot on the last value, read beside a KPI. Decorative:
 * the figure it sits next to carries the meaning.
 */
export function Sparkline({ values, color, className, placeholder = false }: SparklineProps) {
  const gradientId = useId();
  if (placeholder) {
    return (
      <div aria-hidden="true" data-slot="sparkline-placeholder" className={cn('relative', className)}>
        <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} preserveAspectRatio="none" className="h-full w-full">
          <path
            d={`M 0,${VIEW_HEIGHT - PADDING} L ${VIEW_WIDTH},${VIEW_HEIGHT - PADDING}`}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={1.25}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    );
  }
  if (values.length < 2) return null;

  const max = Math.max(...values, 1);
  const step = VIEW_WIDTH / (values.length - 1);
  const plot = (value: number) => VIEW_HEIGHT - PADDING - (value / max) * (VIEW_HEIGHT - PADDING * 2);
  const line = values.map((value, index) => `${index * step},${plot(value)}`).join(' L ');
  const lastValue = values[values.length - 1] ?? 0;

  return (
    <div aria-hidden="true" data-slot="sparkline" className={cn('relative', className)}>
      <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} preserveAspectRatio="none" className="h-full w-full">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M ${line} L ${VIEW_WIDTH},${VIEW_HEIGHT} L 0,${VIEW_HEIGHT} Z`} fill={`url(#${gradientId})`} />
        <path
          d={`M ${line}`}
          fill="none"
          stroke={color}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* dot in HTML, not SVG — preserveAspectRatio=none would squash a circle */}
      <span
        className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
        style={{ backgroundColor: color, left: '100%', top: `${(plot(lastValue) / VIEW_HEIGHT) * 100}%` }}
      />
    </div>
  );
}
