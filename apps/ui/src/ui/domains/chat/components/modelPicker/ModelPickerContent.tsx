// Ported from t3code apps/web/src/components/chat/ModelPickerContent.tsx (MIT, see vendor/t3code).
// Adapted to v4: Base UI's Combobox is cmdk's `Command` (unfiltered: the list is ranked here by
// `rankModelPickerSearch`, cmdk keeps the highlighted row and Up/Down/Enter), LegendList's
// virtualization is a plain scrolling list (catalogs are tens of models), favorites come from
// `modelFavorites.ts`, and the provider setup and Settings links go to Settings → Models. Not
// ported: multi-model picks (`selectedModels`, `onToggleModel`), jump keys
// (`modelPicker.jump.*`), update-required notices, and the screen-reader `announce` calls.
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mastra/playground-ui/components/Command";
import { TooltipProvider } from "@mastra/playground-ui/components/Tooltip";
import { Button } from "@mastra/playground-ui/components/Button";
import { cn } from "@mastra/playground-ui/utils/cn";
import type { ProviderDriverKind, ProviderInstanceId } from "@factory/harness/models/contracts";
import { rankModelPickerSearch } from "@factory/harness/models/modelSearch";
import {
  memo,
  useState,
  useEffect,
  useEffectEvent,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import type { ModelEsque } from "./providerIconUtils";
import { toggleModelFavorite, useModelFavorites } from "./modelFavorites";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "./providerInstances";
import { providerModelKey, sortProviderModelItems } from "./modelOrdering";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  isDefault?: boolean | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

/** The catalog model a selection names: by slug, else by one of its aliases (`opus`). */
export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  return (
    input.options.find((option) => option.slug === input.model) ??
    input.options.find((option) => option.aliases?.includes(input.model))
  );
}

function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    entry.needsSetup &&
    (!isProviderInstancePickerReady(entry) || !options.some((option) => !option.isUnavailable))
  );
}

function adjacentModelPickerProvider(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  selectedInstanceId: ProviderInstanceId | "favorites";
  direction: 1 | -1;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
}) {
  const providers: Array<ProviderInstanceId | "favorites"> = [
    "favorites",
    ...input.entries
      .filter(
        (entry) =>
          !input.disabledInstanceIds?.has(entry.instanceId) &&
          (isProviderInstancePickerReady(entry) ||
            input.selectableUnavailableInstanceIds?.has(entry.instanceId)),
      )
      .map((entry) => entry.instanceId),
  ];
  const index = providers.indexOf(input.selectedInstanceId);
  return providers[
    index < 0
      ? input.direction === 1
        ? 0
        : providers.length - 1
      : (index + input.direction + providers.length) % providers.length
  ]!;
}

// Rendered heights in `--spacing` units. Chrome is the search box and list padding, plus a 1px border.
const ROW_UNITS = 8;
const ROW_SEPARATOR_UNITS = 0.5;
const LIST_CHROME_UNITS = 15.5;

/** A Mastra router id's provider (`anthropic/claude-…`), for the row's logo. */
function modelProviderId(item: ModelPickerItem): string | undefined {
  const slash = item.slug.indexOf("/");
  return slash > 0 ? item.slug.slice(0, slash) : undefined;
}

function ModelPickerProviderNotices({
  setupEntries,
  emptyLabel,
  onRequestClose,
  onOpenProviderSetup,
}: {
  setupEntries: ReadonlyArray<ProviderInstanceEntry>;
  emptyLabel: string;
  onRequestClose: (() => void) | undefined;
  onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const { t } = useTranslation("chat");
  return setupEntries.length > 0 ? (
    <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
      {setupEntries.map((entry) => (
        <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
          <p className="line-clamp-3 text-muted-foreground">
            {t("modelPicker.setupMessage", { label: entry.displayName })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1"
            onClick={() => {
              onRequestClose?.();
              onOpenProviderSetup?.(entry.instanceId);
            }}
          >
            {setupEntries.length > 1
              ? t("modelPicker.setUp", { label: entry.displayName })
              : t("modelPicker.openProviderSetup")}
          </Button>
        </div>
      ))}
    </div>
  ) : (
    <CommandEmpty className="py-3 empty:h-0">{emptyLabel}</CommandEmpty>
  );
}

function ModelPickerList({ children, empty }: { children: ReactNode; empty: boolean }) {
  return (
    <div className={cn("relative min-h-0 overflow-hidden pr-px", empty ? "h-0" : "flex-1")}>
      <CommandList className="scrollbar-gutter-stable h-full max-h-none overflow-x-hidden overscroll-y-contain py-1.5 pl-2 pr-px [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col [&_[cmdk-list-sizer]]:gap-0.5">
        {children}
      </CommandList>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  // Subscribes a capture-phase window keydown listener for the picker's lifetime.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

/** `mod+shift+arrowup` / `mod+shift+arrowdown`: t3code's previous and next provider bindings. */
function providerStepFromEvent(event: KeyboardEvent): 1 | -1 | null {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return null;
  if (event.key === "ArrowUp") return -1;
  if (event.key === "ArrowDown") return 1;
  return null;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** The owning popup moves focus here when it opens (its `initialFocus`). */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Sits beside an effort column: fills the shared row, and stacks above it on narrow screens. */
  docked?: boolean;
  /** Right at the end of the search text moves into the popup's effort column. */
  onFocusEffort?: () => void;
  /** Closes the list column, inside the popup's fixed height. */
  listFooter?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const {
    searchInputRef,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onRequestClose,
    onOpenProviderSetup,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const [highlightedModelKey, setHighlightedModelKey] = useState("");
  const { favorites } = useModelFavorites();
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug = activeModel?.slug ?? props.model;
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerReady(activeEntry);
  const activeInstanceNeedsSetup =
    onOpenProviderSetup !== undefined &&
    activeEntry !== undefined &&
    shouldOfferModelPickerSetup(
      activeEntry,
      modelOptionsByInstance.get(props.activeInstanceId) ?? [],
    );
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    () => {
      if (
        props.lockedProvider !== null ||
        activeInstanceHasSelectableUnavailableModel ||
        activeInstanceNeedsSetup
      ) {
        return props.activeInstanceId;
      }
      return favorites.length > 0 ? "favorites" : props.activeInstanceId;
    },
  );
  const favoritesSet = new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        activeModel?.isLegacy &&
          !favoritesSet.has(providerModelKey(props.activeInstanceId, activeModelSlug))
          ? [props.activeInstanceId]
          : [],
      ),
  );
  const [searchHeight, setSearchHeight] = useState(0);

  const focusSearchInput = () => {
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const handleSelectInstance = (instanceId: ProviderInstanceId | "favorites") => {
    setSelectedInstanceId(instanceId);
    window.requestAnimationFrame(() => {
      focusSearchInput();
    });
  };

  const toggleLegacySection = (instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  };

  const handleModelSelect = (modelSlug: string, instanceId: ProviderInstanceId): string | null => {
    if (getModelDisabledReason?.(instanceId, modelSlug)) {
      return null;
    }
    const options = modelOptionsByInstance.get(instanceId);
    if (!options) {
      return null;
    }
    const resolvedModel = options.find((option) => option.slug === modelSlug)?.slug;
    if (!resolvedModel) return null;
    onInstanceModelChange(instanceId, resolvedModel);
    return resolvedModel;
  };

  const lockedProvider = props.lockedProvider;
  const canOpenProviderSetup = onOpenProviderSetup !== undefined;

  const entryByInstanceId = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  const matchesLockedProvider = (entry: Pick<ProviderInstanceEntry, "driverKind">): boolean => {
    if (lockedProvider === null) return true;
    return entry.driverKind === lockedProvider;
  };

  const selectableUnavailableInstanceIds = (() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (canOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? [])
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  })();

  const flatModels = (() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        continue;
      }
      for (const model of models) {
        if (
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isDefault ? { isDefault: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
        });
      }
    }
    return out;
  })();

  const isLocked = lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  // Fit the tallest tab so switching tabs never resizes the popup and moves the rail under the cursor.
  const tallestTabUnits = (() => {
    const unitsByTab = new Map<ProviderInstanceId | "favorites", number>();
    const addRow = (tab: ProviderInstanceId | "favorites") => {
      const previous = unitsByTab.get(tab);
      unitsByTab.set(
        tab,
        previous === undefined ? ROW_UNITS : previous + ROW_SEPARATOR_UNITS + ROW_UNITS,
      );
    };
    const tabsWithLegacyRow = new Set<ProviderInstanceId>();
    for (const model of flatModels) {
      if (!matchesLockedProvider(model)) continue;
      const isFavorite = favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      if (isFavorite) addRow("favorites");
      if (model.isLegacy && !isFavorite) {
        tabsWithLegacyRow.add(model.instanceId);
      } else {
        addRow(model.instanceId);
      }
    }
    for (const instanceId of tabsWithLegacyRow) addRow(instanceId);
    return Math.max(0, ...unitsByTab.values());
  })();
  const lockedDisabledInstanceIds = (() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  })();
  const sidebarInstanceEntries = (() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  })();
  const showSidebar = !isSearching && sidebarInstanceEntries.length > 0;
  const instanceOrder = instanceEntries.map((entry) => entry.instanceId);

  const filteredModels = (() => {
    let result = flatModels;

    if (searchQuery.trim()) {
      const candidates =
        lockedProvider !== null ? result.filter((m) => matchesLockedProvider(m)) : result;
      return rankModelPickerSearch(candidates, searchQuery, (model) => ({
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: model.instanceDisplayName,
        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
      }));
    }

    if (lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
      if (selectedInstanceId === "favorites") {
        result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
      } else {
        result = result.filter((m) => m.instanceId === selectedInstanceId);
      }
    } else if (selectedInstanceId === "favorites") {
      result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
    });
  })();

  const legacySection = (() => {
    if (isSearching || selectedInstanceId === "favorites") {
      return null;
    }
    const currentModels: ModelPickerItem[] = [];
    const legacyModels: ModelPickerItem[] = [];
    for (const model of filteredModels) {
      const isLegacy =
        model.isLegacy && !favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      (isLegacy ? legacyModels : currentModels).push(model);
    }
    if (legacyModels.length === 0) {
      return null;
    }
    return {
      key: modelPickerLegacySectionKey(selectedInstanceId),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyInstances.has(selectedInstanceId),
    };
  })();

  const visibleModels = (() => {
    if (!legacySection) {
      return filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.isExpanded ? legacySection.legacyModels : []),
    ];
  })();

  const selectedEntry =
    selectedInstanceId === "favorites" ? undefined : entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    !isSearching && canOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            (selectedEntry
              ? entry.instanceId === selectedEntry.instanceId
              : filteredModels.length === 0),
        )
      : [];

  const filteredItemKeys = ((): string[] => {
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    // The toggle trails the list, so expanding it reveals older models above it.
    return legacySection ? [...modelKeys, legacySection.key] : modelKeys;
  })();
  const filteredModelByKey = ((): ReadonlyMap<string, ModelPickerItem> =>
    new Map(
      visibleModels.map(
        (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
      ),
    ))();

  const badgedInstanceIds = new Set(
    instanceEntries
      .filter((entry) => shouldShowInstanceBadge(entry, instanceEntries))
      .map((entry) => entry.instanceId),
  );

  const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) {
      return;
    }
    const step = providerStepFromEvent(event);
    if (step === null) return;
    event.preventDefault();
    event.stopPropagation();
    const next = adjacentModelPickerProvider({
      entries: sidebarInstanceEntries,
      selectedInstanceId,
      direction: step,
      disabledInstanceIds: lockedDisabledInstanceIds,
      selectableUnavailableInstanceIds,
    });
    setSearchQuery("");
    handleSelectInstance(next);
  };

  return (
    <TooltipProvider delay={0}>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className={cn(
          "relative flex w-screen max-w-90 flex-row overflow-hidden",
          props.docked ? "max-sm:h-56 max-sm:w-full max-sm:max-w-none" : "max-h-86.5",
        )}
        // Docked, the popup sets the height; a minimum here would overflow short windows.
        style={
          props.docked
            ? undefined
            : isSearching
              ? { height: searchHeight }
              : {
                  minHeight: `min(calc(var(--spacing) * ${tallestTabUnits + LIST_CHROME_UNITS} + 1px), calc(var(--spacing) * 86.5))`,
                }
        }
        data-model-picker-content="true"
      >
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            onFocusSearch={focusSearchInput}
            instanceEntries={sidebarInstanceEntries}
            showFavorites
            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}
            {...(lockedDisabledInstanceIds
              ? {
                  disabledInstanceIds: lockedDisabledInstanceIds,
                  getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                    t("modelPicker.instanceLocked", { label: entry.displayName }),
                }
              : {})}
          />
        )}

        <Command
          shouldFilter={false}
          loop
          value={highlightedModelKey}
          onValueChange={setHighlightedModelKey}
          label={t("modelPicker.sessionModel")}
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden rounded-none bg-transparent",
            showSidebar && "border-l border-border/70",
          )}
        >
          <CommandInput
            ref={searchInputRef}
            placeholder={t("modelPicker.search")}
            value={searchQuery}
            wrapperClassName="mx-3 px-0 pt-1"
            onValueChange={(value) => {
              if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
              setSearchQuery(value);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) {
                e.stopPropagation();
                return;
              }
              if (
                showSidebar &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                  (e.key === "Tab" && e.shiftKey))
              ) {
                const sidebar = e.currentTarget
                  .closest("[data-model-picker-content]")
                  ?.querySelector("[data-model-picker-sidebar]");
                const button =
                  sidebar?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
                  sidebar?.querySelector<HTMLButtonElement>("button");
                if (button) {
                  e.preventDefault();
                  e.stopPropagation();
                  button.focus();
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onRequestClose?.();
                return;
              }
              if (
                props.onFocusEffort &&
                e.key === "ArrowRight" &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.shiftKey &&
                e.currentTarget.selectionStart === searchQuery.length
              ) {
                e.preventDefault();
                e.stopPropagation();
                // The column shows the selected model's effort, so a highlighted model is picked
                // first; the owning popup then moves focus to that model's levels.
                const highlighted = highlightedModelKey
                  ? parseModelPickerModelKey(highlightedModelKey)
                  : null;
                const pickedNew =
                  highlighted !== null &&
                  highlightedModelKey !== activeModelKey &&
                  handleModelSelect(highlighted.slug, highlighted.instanceId) !== null;
                if (!pickedNew) props.onFocusEffort();
              }
            }}
          />

          <ModelPickerList empty={filteredItemKeys.length === 0}>
            {filteredItemKeys.map((modelKey) => {
              if (legacySection?.key === modelKey) {
                return (
                  <CommandItem
                    key={modelKey}
                    value={modelKey}
                    aria-expanded={legacySection.isExpanded}
                    onSelect={() => {
                      const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
                      if (legacyInstanceId) toggleLegacySection(legacyInstanceId);
                    }}
                    className="group w-full cursor-pointer"
                  >
                    <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground group-data-[selected=true]:text-foreground">
                      {legacySection.isExpanded
                        ? t("modelPicker.showLess")
                        : t("modelPicker.showMore")}
                    </span>
                  </CommandItem>
                );
              }
              const model = filteredModelByKey.get(modelKey);
              if (!model) {
                return null;
              }
              const disabledReason = getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
              return (
                <ModelListRow
                  key={modelKey}
                  slug={model.slug}
                  name={model.name}
                  subProvider={model.subProvider}
                  providerId={modelProviderId(model)}
                  instanceId={model.instanceId}
                  driverKind={model.driverKind}
                  providerDisplayName={model.instanceDisplayName}
                  isFavorite={favoritesSet.has(providerModelKey(model.instanceId, model.slug))}
                  isSelected={modelKey === activeModelKey}
                  favoriteStarOnHover={selectedInstanceId === "favorites" && !isSearching}
                  showInstanceBadge={badgedInstanceIds.has(model.instanceId)}
                  showNewBadge={model.badge === "new"}
                  showDefaultBadge={model.isDefault === true}
                  unavailable={model.isUnavailable === true}
                  disabledReason={disabledReason}
                  onSelect={(instanceId, slug) => void handleModelSelect(slug, instanceId)}
                  onToggleFavorite={toggleModelFavorite}
                />
              );
            })}
          </ModelPickerList>
          <ModelPickerProviderNotices
            setupEntries={providerSetupEntries}
            emptyLabel={
              selectedInstanceId === "favorites" && !isSearching
                ? t("modelPicker.noFavorites")
                : t("modelPicker.noMatch")
            }
            onRequestClose={onRequestClose}
            onOpenProviderSetup={onOpenProviderSetup}
          />
          {props.listFooter}
        </Command>
      </div>
    </TooltipProvider>
  );
});
