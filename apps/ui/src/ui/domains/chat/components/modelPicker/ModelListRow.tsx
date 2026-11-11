// Ported from t3code apps/web/src/components/chat/ModelListRow.tsx (MIT, see vendor/t3code).
// t3code's Base UI `ComboboxItem` is v4's cmdk `CommandItem` (picked through `onSelect`); the
// jump-key label is not ported (v4 has no keybinding config for `modelPicker.jump.*`).
import { Badge } from "@mastra/playground-ui/components/Badge";
import { Button } from "@mastra/playground-ui/components/Button";
import { CommandItem } from "@mastra/playground-ui/components/Command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mastra/playground-ui/components/Tooltip";
import { cn } from "@mastra/playground-ui/utils/cn";
import type { ProviderDriverKind, ProviderInstanceId } from "@factory/harness/models/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getDisplayModelName } from "./providerIconUtils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export const ModelListRow = memo(function ModelListRow(props: {
  slug: string;
  name: string;
  subProvider?: string | undefined;
  /** The model's own provider (a Mastra router id's prefix), for its logo. */
  providerId?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  isFavorite: boolean;
  /** In Favorites every row is starred, so the star shows only on hover. */
  favoriteStarOnHover?: boolean;
  isSelected: boolean;
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge: boolean;
  showNewBadge?: boolean;
  /** The model a chat starts on (v4 marks the Factory's default model in its picker). */
  showDefaultBadge?: boolean;
  unavailable?: boolean;
  disabledReason?: string | null;
  onSelect: (instanceId: ProviderInstanceId, slug: string) => void;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
}) {
  const { t } = useTranslation("chat");
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };
  const favoriteLabel = props.isFavorite
    ? t("modelPicker.removeFavorite")
    : t("modelPicker.addFavorite");

  const row = (
    <CommandItem
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      onSelect={() => props.onSelect(props.instanceId, props.slug)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason && "data-[disabled=true]:pointer-events-auto data-[disabled=true]:cursor-not-allowed",
      )}
    >
      {/* One row shape in every tab: the logo names the provider, so Favorites needs no second line. */}
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        displayName={props.providerDisplayName}
        providerId={props.providerId}
        showBadge={props.showInstanceBadge}
        className="size-4"
        iconClassName="size-4"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div
          className="min-w-0 truncate text-sm font-normal leading-snug"
          // Names the row in full on hover only when it is cut off.
          onPointerEnter={(event) => {
            const name = event.currentTarget;
            name.title = name.scrollWidth > name.clientWidth ? getDisplayModelName(model) : "";
          }}
        >
          {getDisplayModelName(model)}
          {/* The logo is decorative, so name the provider for screen readers. */}
          <span className="sr-only">, {props.subProvider ?? props.providerDisplayName}</span>
        </div>
        {props.isSelected ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        {props.subProvider ? (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">
            {props.subProvider}
          </span>
        ) : null}
        {props.showNewBadge ? (
          <Badge variant="blue" size="xs" aria-label={t("modelPicker.newModel")}>
            {t("modelPicker.new")}
          </Badge>
        ) : null}
        {props.showDefaultBadge ? (
          <Badge variant="blue" size="xs">
            {t("common.default")}
          </Badge>
        ) : null}
        {props.unavailable ? (
          <Badge variant="neutral" size="xs">
            {t("modelPicker.unavailableBadge")}
          </Badge>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="icon-sm"
          variant="ghost"
          tooltip={favoriteLabel}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleFavorite(props.instanceId, props.slug);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          disabled={Boolean(props.disabledReason)}
          aria-label={favoriteLabel}
        >
          <StarIcon
            className={cn(
              "size-3.5 sm:size-3",
              props.isFavorite && "fill-current text-warning",
              (!props.isFavorite || props.favoriteStarOnHover) &&
                "opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
            )}
          />
        </Button>
      </div>
    </CommandItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>{row}</TooltipTrigger>
      <TooltipContent side="left" align="center">
        {props.disabledReason}
      </TooltipContent>
    </Tooltip>
  );
});
