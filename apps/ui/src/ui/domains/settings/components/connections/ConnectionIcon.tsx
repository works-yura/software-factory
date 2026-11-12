import { Server } from 'lucide-react';
import { siClickup, siGithub, siGitlab, siGooglecloud } from 'simple-icons';
import type { SimpleIcon } from 'simple-icons';

/**
 * Brand marks from simple-icons (CC0), in their brand colour, by the logo key the server or the kind
 * names. A near-black mark takes the text colour instead and stays visible on a dark surface. An
 * unknown key (an MCP server, a connector without a mark here) gets a plain server glyph.
 */
const BRANDS: Partial<Record<string, { icon: SimpleIcon; ink?: boolean }>> = {
  'google-cloud': { icon: siGooglecloud },
  clickup: { icon: siClickup },
  github: { icon: siGithub, ink: true },
  gitlab: { icon: siGitlab },
};

export function BrandLogo({ kind, size = 20 }: { kind: string; size?: number }) {
  const brand = BRANDS[kind];
  if (!brand) return <Server aria-hidden className="text-muted-foreground" style={{ width: size, height: size }} />;
  return (
    <svg aria-hidden role="img" viewBox="0 0 24 24" width={size} height={size} className={brand.ink ? 'text-foreground fill-current' : undefined}>
      <path d={brand.icon.path} fill={brand.ink ? undefined : `#${brand.icon.hex}`} />
    </svg>
  );
}

/** A logo (by key) in a plain 32px slot (no box), as the kit's command rows draw logos. */
export function ConnectionIcon({ kind }: { kind: string }) {
  return (
    <span aria-hidden className="grid size-8 shrink-0 place-items-center p-1.5">
      <BrandLogo kind={kind} size={20} />
    </span>
  );
}
