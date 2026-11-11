// The status line's model picker. The Popover is playground-ui's (Base UI underneath), the trigger
// is a ghost button, and the shortcut label is fixed (`mod+shift+m`) since there is no keybinding
// config. Limitations: no catalog refresh on open (the server's catalog is bundled), one model per
// trigger, and no background scroll lock.
import { Badge } from "@mastra/playground-ui/components/Badge";
import { buttonVariants } from "@mastra/playground-ui/components/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@mastra/playground-ui/components/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mastra/playground-ui/components/Tooltip";
import { useKeyboardShortcutLabel } from "@mastra/playground-ui/hooks/use-keyboard-shortcut-label";
import { cn } from "@mastra/playground-ui/utils/cn";
import type { ProviderDriverKind, ProviderInstanceId } from "@factory/harness/models/contracts";
import { ChevronDown } from "lucide-react";
import { createContext, memo, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { type ModelEsque, getDisplayModelName, getTriggerDisplayModelName } from "./providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "./providerInstances";

/** The trigger's density. */
export type ComposerControlSize = "sm" | "xs";

/** What a docked effort column needs from its picker: the model it serves. */
export const DockedPickerContext = createContext<{ modelLabel: string }>({ modelLabel: "" });

/**
 * composer.effort marks the model picker trigger it opens; the picker then moves focus to the
 * selected effort level once its popup is open.
 */
export function markOpenToEffort(trigger: HTMLElement): void {
  trigger.dataset.openToEffort = "true";
}

/** Reads and clears an open-to mark: effort from composer.effort. */
function takeOpenTarget(trigger: HTMLElement | null): "effort" | null {
  if (trigger?.dataset.openToEffort) {
    delete trigger.dataset.openToEffort;
    return "effort";
  }
  return null;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  size?: ComposerControlSize;
  disabled?: boolean;
  /** The picker is waiting on a switch it sent. */
  busy?: boolean;
  open?: boolean;
  popupAlign?: "start" | "end";
  triggerClassName?: string;
  /** Replaces the model name (and its icon and suffix) in the trigger, as in "Change model". */
  triggerLabel?: string;
  triggerAriaLabel?: string;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  onOpenChange?: (open: boolean) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Shown after the model name inside the same trigger, such as the effort level. */
  triggerSuffix?: ReactNode;
  /** Names the suffix for the tooltip and screen readers. */
  triggerDetail?: string | null;
  /**
   * Docks an effort column beside the list and a footer under both. The popup then stays open
   * until Escape or an outside press, and picking a model moves focus to its levels.
   */
  effortColumn?: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = props.triggerRef ?? ownTriggerRef;
  const popupRef = useRef<HTMLDivElement | null>(null);
  const size = props.size ?? "sm";
  const docked = props.effortColumn !== undefined;
  const shortcutLabel = useKeyboardShortcutLabel("⇧M");

  const activeEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null;

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  const selectedModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: selectedInstanceOptions,
  });
  const triggerTitle = selectedModel
    ? getTriggerDisplayModelName(selectedModel, activeEntry?.driverKind)
    : props.model || t("modelPicker.chooseModel");
  const triggerLabel = selectedModel
    ? `${getDisplayModelName(selectedModel)}${selectedModel.isUnavailable ? ` (${t("modelPicker.unavailableBadge")})` : ""}`
    : triggerTitle;
  const showInstanceBadge =
    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  /**
   * Focuses the selected reasoning level, else the first level. With `rows: "any"` it falls back
   * to the column's first enabled option. False when nothing took focus.
   */
  const focusEffort = (rows: "levels" | "any") => {
    const column = popupRef.current?.querySelector("[data-model-picker-effort]");
    const level =
      column?.querySelector<HTMLElement>(
        '[data-effort-level][aria-checked="true"]:not(:disabled)',
      ) ?? column?.querySelector<HTMLElement>("[data-effort-level]:not(:disabled)");
    // No aria-checked here: an On switch is checked but is not where focus belongs.
    const row =
      level ??
      (rows === "any"
        ? column?.querySelector<HTMLElement>("[data-effort-row]:not(:disabled)")
        : null);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
    return row != null;
  };

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    if (!docked) {
      setIsMenuOpen(false);
      return;
    }
    // The column renders the new model's levels on commit.
    window.requestAnimationFrame(() => focusEffort("levels"));
  };

  const triggerTooltipContent = [props.triggerLabel ?? triggerLabel, props.triggerDetail, shortcutLabel]
    .filter(Boolean)
    .join(" · ");

  const picker = (
    <ModelPickerContent
      searchInputRef={searchInputRef}
      activeInstanceId={activeInstanceId}
      model={props.model}
      lockedProvider={props.lockedProvider}
      instanceEntries={props.instanceEntries}
      modelOptionsByInstance={props.modelOptionsByInstance}
      onRequestClose={() => setIsMenuOpen(false)}
      {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
      getModelDisabledReason={(instanceId, model) =>
        props.disabled
          ? t("modelPicker.pickerDisabled")
          : (props.getModelDisabledReason?.(instanceId, model) ?? null)
      }
      onInstanceModelChange={handleInstanceModelChange}
      {...(docked ? { docked, onFocusEffort: () => void focusEffort("any") } : {})}
    />
  );

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
      onOpenChangeComplete={(open) => {
        const target = takeOpenTarget(triggerRef.current);
        if (open && docked && target) focusEffort("any");
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              ref={triggerRef}
              render={
                <button
                  type="button"
                  aria-label={[
                    props.triggerAriaLabel ?? props.triggerLabel ?? triggerLabel,
                    props.triggerLabel === undefined ? props.triggerDetail : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  aria-busy={props.busy || undefined}
                  data-chat-provider-model-picker="true"
                  disabled={props.disabled}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "group/model-trigger min-w-0 max-w-64 shrink justify-between whitespace-nowrap",
                    props.triggerClassName ?? "text-muted-foreground",
                  )}
                />
              }
            />
          }
        >
          <span
            className={cn("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}
          >
            {activeEntry && props.triggerLabel === undefined ? (
              // Narrow compacted composers hide the provider icon before truncating the name.
              <span data-chat-provider-model-picker-icon className="contents">
                <ProviderInstanceIcon
                  driverKind={activeEntry.driverKind}
                  displayName={activeEntry.displayName}
                  providerId={
                    props.model.includes("/") ? props.model.slice(0, props.model.indexOf("/")) : undefined
                  }
                  showBadge={showInstanceBadge}
                  className="size-4"
                  iconClassName="size-4"
                />
              </span>
            ) : null}
            <span
              className="min-w-0 flex-1 overflow-hidden truncate"
              data-chat-provider-model-picker-label="true"
            >
              {props.triggerLabel ?? triggerTitle}
            </span>
            {props.triggerLabel === undefined ? props.triggerSuffix : null}
            {selectedModel?.isUnavailable && props.triggerLabel === undefined ? (
              <Badge variant="neutral" size="xs">
                {t("modelPicker.unavailableBadge")}
              </Badge>
            ) : null}
            <ChevronDown aria-hidden size={12} className="shrink-0" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{triggerTooltipContent}</TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={(popup) => {
          popupRef.current = popup;
        }}
        initialFocus={searchInputRef}
        align={props.popupAlign ?? "start"}
        // Docked, the popup opens above the composer and slides over it when that space is short,
        // so a short window gets its full height (Floating UI sizes to the viewport) instead of a sliver.
        {...(docked
          ? { side: "top" as const, collisionAvoidance: { side: "shift", align: "shift" } as const }
          : {})}
        className="w-auto max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        {props.effortColumn ? (
          <DockedPickerContext value={{ modelLabel: triggerTitle }}>
            <div className="flex max-h-(--available-height) flex-col">
              {/* One fixed height, so a model with more options never resizes the popup. Short
                  windows shrink it and keep the footer. */}
              <div className="flex h-86.5 min-h-0 max-sm:h-auto max-sm:flex-col">
                {picker}
                <div
                  data-model-picker-effort
                  className="flex min-h-0 w-48 flex-col sm:shrink-0 border-l border-border/70 bg-fill-subtle max-sm:h-64 max-sm:w-full max-sm:border-t max-sm:border-l-0"
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" || event.altKey || event.ctrlKey || event.metaKey)
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    searchInputRef.current?.focus();
                  }}
                >
                  {props.effortColumn}
                </div>
              </div>
              {props.footer}
            </div>
          </DockedPickerContext>
        ) : (
          picker
        )}
      </PopoverContent>
    </Popover>
  );
});
