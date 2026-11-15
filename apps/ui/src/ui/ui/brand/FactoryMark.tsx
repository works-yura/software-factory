import { cn } from '@mastra/playground-ui/utils/cn';

import './factory-mark.css';

/**
 * Factory's mark: a geometric F on a 32-unit grid, drawn as its three strokes so it can assemble.
 * The same geometry is in `public/factory.svg`, the session favicons and the app icons
 * (`scripts/brand-icons.mjs` renders those); change them together.
 */
export const FACTORY_MARK_PARTS = {
  stem: { x: 8, y: 4, width: 6, height: 24 },
  top: { x: 8, y: 4, width: 18, height: 6 },
  middle: { x: 8, y: 14, width: 14, height: 6 },
} as const;

const RADIUS = 2;

export type FactoryMarkProps = {
  className?: string;
  /** `enter` assembles the F once when it mounts (stem, then the bars); reduced motion shows it whole. */
  animate?: 'enter';
  /** Named for assistive tech; without a label the mark is decorative. */
  'aria-label'?: string;
};

export function FactoryMark({ className, animate, 'aria-label': label }: FactoryMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="currentColor"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-animate={animate}
      className={cn('factory-mark block shrink-0', className)}
    >
      {(Object.keys(FACTORY_MARK_PARTS) as (keyof typeof FACTORY_MARK_PARTS)[]).map(part => (
        <rect key={part} className={`factory-mark-${part}`} rx={RADIUS} {...FACTORY_MARK_PARTS[part]} />
      ))}
    </svg>
  );
}
