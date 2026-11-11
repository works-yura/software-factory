// The model picker's provider sidebar: a `role="toolbar"` with vertical arrow-key movement; the
// tooltips are playground-ui's.
import { Tooltip, TooltipContent, TooltipTrigger } from "@mastra/playground-ui/components/Tooltip";
import { cn } from "@mastra/playground-ui/utils/cn";
import type { ProviderInstanceId } from "@factory/harness/models/contracts";
import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { StarIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { translator } from "../../../../i18n/t";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "./providerInstances";

const tk = translator("chat");

function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
    return tk("modelPicker.instanceDisabled", { label });
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  if (entry.needsSetup) return tk("modelPicker.instanceNeedsSetup", { label });
  return entry.status === "warning"
    ? tk("modelPicker.instanceLimited", { label })
    : tk("modelPicker.instanceUnavailable", { label });
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

const RAIL_BUTTON =
  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none";

/** Up and Down move between the rail's buttons, as Base UI's vertical toolbar does. */
function moveInRail(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([aria-disabled='true'])"),
  );
  const index = buttons.findIndex((button) => button === document.activeElement);
  const next = buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const { t } = useTranslation("chat");
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  // Reads the selected provider item's DOM offset to position the selection indicator.
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [
    // Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    showFavorites,
  ]);

  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      className="w-11 shrink-0 overflow-hidden bg-fill-subtle"
      data-model-picker-sidebar="true"
      aria-label={t("modelPicker.providers")}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
        moveInRail(event);
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-foreground transition-[top] duration-200 ease-out"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <div className="relative w-full" data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        className={RAIL_BUTTON}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label={t("modelPicker.favorites")}
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      />
                    }
                  >
                    <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    {t("modelPicker.favorites")}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);

            const tooltip = isUnavailable
              ? describeUnavailableInstance(entry)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : entry.displayName;

            return (
              <div
                key={entry.instanceId}
                className="relative w-full"
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        className={cn(
                          RAIL_BUTTON,
                          isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                        )}
                        onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                        // Focusable while disabled, so its tooltip still says why.
                        aria-disabled={isDisabled || undefined}
                        aria-pressed={isSelected}
                        type="button"
                        aria-label={isUnavailable || isContextDisabled ? tooltip : entry.displayName}
                      />
                    }
                  >
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind}
                      displayName={entry.displayName}
                      showBadge={showInstanceBadge}
                      className="size-6 z-30"
                      iconClassName="size-5"
                    />
                  </TooltipTrigger>
                  <TooltipContent
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    {tooltip}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
