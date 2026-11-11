// A provider instance's icon with Factory's provider logos: a Mastra row shows its model's
// provider, an instance the harness's own mark.
import { ProviderLogo } from "@mastra/playground-ui/domains/llm";
import { cn } from "@mastra/playground-ui/utils/cn";

const HARNESS_LOGOS: Readonly<Record<string, string>> = {
  "claude-code": "anthropic",
};

export function ProviderInstanceIcon(props: {
  driverKind: string;
  displayName: string;
  /** The model's own provider (`anthropic`), when the instance spans several. */
  providerId?: string | undefined;
  showBadge?: boolean;
  className?: string;
  iconClassName?: string;
}) {
  const providerId = props.providerId ?? HARNESS_LOGOS[props.driverKind] ?? props.driverKind;
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex shrink-0 items-center justify-center", props.className)}
    >
      <ProviderLogo providerId={providerId} className={props.iconClassName} />
      {props.showBadge ? (
        <span className="absolute right-[-0.125rem] bottom-[-0.125rem] flex h-3 min-w-3 items-center justify-center rounded-full bg-muted px-0.5 text-[8px] leading-none text-foreground">
          {props.displayName.slice(0, 1).toUpperCase()}
        </span>
      ) : null}
    </span>
  );
}
