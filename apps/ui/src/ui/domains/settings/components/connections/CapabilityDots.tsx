import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { Bug, Database, GitBranch, Inbox, Plug, ScrollText, Wrench } from 'lucide-react';
import type { ConnectionProvidesView } from '@factory/contracts';
import type { LucideIcon } from 'lucide-react';


/** Tints from the badge palette: what agents call (violet), what brings work (green), code (blue). */
const TINT = {
  tools: 'bg-badge-purple-subtle text-badge-purple-foreground',
  sources: 'bg-badge-green-subtle text-badge-green-foreground',
  code: 'bg-badge-blue-subtle text-badge-blue-foreground',
} as const;

export interface CapabilityDot {
  key: string;
  icon: LucideIcon;
  tint: string;
  label: string;
}

/** Small round tinted icons with a tooltip each, as Mastra's Connect page marks capabilities. */
export function CapabilityDots({ dots }: { dots: CapabilityDot[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {dots.map(dot => (
        <Tooltip key={dot.key}>
          <TooltipTrigger render={<span role="img" aria-label={dot.label} className="flex shrink-0 items-center" />}>
            <span className={`shadow-inset grid size-5 place-items-center rounded-full ${dot.tint}`}>
              <dot.icon aria-hidden className="size-icon-xs! text-current!" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{dot.label}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

/** Icons for the capability keys a server's connector may name; an unknown key gets a plug. */
const SERVER_DOTS: Record<string, { icon: LucideIcon; tint: string }> = {
  tools: { icon: Wrench, tint: TINT.tools },
  logs: { icon: ScrollText, tint: TINT.tools },
  crashes: { icon: Bug, tint: TINT.tools },
  database: { icon: Database, tint: TINT.tools },
  tasks: { icon: Inbox, tint: TINT.sources },
  code: { icon: GitBranch, tint: TINT.code },
  repositories: { icon: GitBranch, tint: TINT.code },
};

/** Dots for a connector's capabilities as the server names them: the key picks the icon, the label is the server's. */
export function serverDots(capabilities: readonly ConnectionProvidesView[]): CapabilityDot[] {
  return capabilities.map(capability => ({
    key: capability.key,
    ...(SERVER_DOTS[capability.key] ?? { icon: Plug, tint: TINT.tools }),
    label: capability.label,
  }));
}
