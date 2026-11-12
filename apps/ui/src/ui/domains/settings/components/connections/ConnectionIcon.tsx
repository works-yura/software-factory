import { Server } from 'lucide-react';
import { siClickup, siGithub, siGitlab, siGooglecloud } from 'simple-icons';
import type { SimpleIcon } from 'simple-icons';

import type { ConnectionKind } from '../../connections/connections';

/**
 * Brand marks from simple-icons (CC0), in their brand colour. GitHub's mark is near-black, so it
 * takes the text colour instead and stays visible on a dark surface. An MCP server has no brand: a
 * plain server glyph.
 */
const BRANDS: Partial<Record<ConnectionKind, { icon: SimpleIcon; ink?: boolean }>> = {
  'google-cloud': { icon: siGooglecloud },
  clickup: { icon: siClickup },
  github: { icon: siGithub, ink: true },
  gitlab: { icon: siGitlab },
};

export function BrandLogo({ kind, size = 20 }: { kind: ConnectionKind; size?: number }) {
  const brand = BRANDS[kind];
  if (!brand) return <Server aria-hidden className="text-icon3" style={{ width: size, height: size }} />;
  return (
    <svg aria-hidden role="img" viewBox="0 0 24 24" width={size} height={size} className={brand.ink ? 'text-icon6 fill-current' : undefined}>
      <path d={brand.icon.path} fill={brand.ink ? undefined : `#${brand.icon.hex}`} />
    </svg>
  );
}

/** The integration's mark on a quiet tile, the same in the list, a connection's page and «Додати підключення». */
export function ConnectionIcon({ kind, size = 'md' }: { kind: ConnectionKind; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={`border-border1 bg-surface3 flex shrink-0 items-center justify-center rounded-lg border ${size === 'lg' ? 'size-10' : 'size-9'}`}
    >
      <BrandLogo kind={kind} size={size === 'lg' ? 22 : 18} />
    </span>
  );
}
