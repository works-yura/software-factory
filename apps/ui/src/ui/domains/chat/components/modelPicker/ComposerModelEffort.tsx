// Ported from t3code apps/web/src/components/chat/ComposerModelEffort.tsx (MIT, see vendor/t3code).
// t3code's Menu is v4's DropdownMenu, its Switch and Tooltip the playground-ui ones. The footer's
// permissions menu is replaced by where the selection comes from (this session or the Factory's
// default, with "Use default"), as v4's thinking control showed; a context window select sits in
// the footer beside speed and Ultracode.
import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@factory/harness/models/modelTraits";
import type { ProviderOptionDescriptor } from "@factory/harness/models/contracts";
import { getProviderOptionCurrentLabel } from "@factory/harness/models/model";
import { Button } from "@mastra/playground-ui/components/Button";
import { DropdownMenu } from "@mastra/playground-ui/components/DropdownMenu";
import { Switch } from "@mastra/playground-ui/components/Switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mastra/playground-ui/components/Tooltip";
import { cn } from "@mastra/playground-ui/utils/cn";
import { CheckIcon, ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, use, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { translator } from "../../../../i18n/t";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "./EffortGlyph";
import { DockedPickerContext, type ComposerControlSize } from "./ProviderModelPicker";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  ultrathinkInBodyNote,
  useTraitsSelection,
} from "./TraitsPicker";

const tk = translator("chat");

/** t3code's Appearance setting: the effort as its word, or as bars. */
export type EffortDisplay = "label" | "bars";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Service tiers, Claude's Fast mode, Ultracode and the context window sit in the footer, not the column. */
function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const contextWindowSelect =
    selects.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    contextWindowSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter(
      (descriptor) => descriptor !== speedSelect && descriptor !== contextWindowSelect,
    ),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning levels under the header that names it. Other options,
 * such as an agent's session mode, sit below as one row each.
 */
function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * What the model trigger shows after the model name: the effort word (or bars, per the
 * Appearance setting), a bolt for Fast, a workflow icon for Ultracode, and other traits such as a
 * context window.
 */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  effortDisplay: EffortDisplay,
  size: ComposerControlSize,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const modelSelection =
    traits.instanceId && traits.model
      ? { instanceId: traits.instanceId, model: traits.model, options: traits.modelOptions ?? [] }
      : null;
  const primary = visibility.primarySelectDescriptor;
  const display = buildTraitsTriggerDisplay({
    descriptors: visibility.descriptors,
    primarySelectDescriptorId: primary?.id ?? null,
    ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
    modelSelection,
    reportedModelSelection: traits.reportedModelSelection,
  });
  // The same reasoning control the column lists, wherever the agent put it among its options.
  const reasoning =
    columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
      ?.descriptor ?? null;
  const ultrathink = visibility.ultrathinkPromptControlled && reasoning === primary;
  const glyph =
    reasoning?.type === "select"
      ? resolveEffortGlyph(
          reasoning,
          ultrathink
            ? "ultrathink"
            : getDescriptorStringValue(reasoning, modelSelection, traits.reportedModelSelection),
        )
      : null;
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : !reasoning
      ? null
      : reasoning.type === "boolean"
        ? `${reasoning.label} ${reasoning.currentValue === true ? tk("modelPicker.on") : tk("modelPicker.off")}`
        : ultrathink
          ? "Ultrathink"
          : (getProviderOptionCurrentLabel(
              reasoning,
              modelSelection,
              traits.reportedModelSelection,
            ) ?? (reasoning.id === "thinking" ? reasoning.label : null));
  const fast = display.speedLabel === "Fast" || display.speedLabel === "Ultrafast";
  // Agent options such as modes live in the picker; the trigger adds only the context window.
  const contextWindow =
    visibility.contextWindowDescriptor &&
    getProviderOptionCurrentLabel(
      visibility.contextWindowDescriptor,
      modelSelection,
      traits.reportedModelSelection,
    );
  if (!word && !glyph && !fast && !display.ultracode && !contextWindow)
    return { suffix: null, detail: display.label };
  return {
    detail: display.label,
    suffix: (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-muted-foreground group-hover/model-trigger:text-foreground group-data-[popup-open]/model-trigger:text-foreground",
          // A word space after the model name: the regular trigger's gap is wider than one.
          size === "sm" && "-ms-0.5",
        )}
      >
        {word ? (
          <span data-composer-control-label className="max-w-24 truncate">
            {word}
          </span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} />
        ) : null}
        {fast ? <FastBolt ultra={display.speedLabel === "Ultrafast"} /> : null}
        {display.ultracode ? (
          <WorkflowIcon aria-hidden="true" data-composer-control-icon className="size-3" />
        ) : null}
        {contextWindow ? (
          <span
            // A label, so icon-only footers drop it; compacted rows drop it before the model.
            data-composer-control-label
            data-composer-secondary-trait
            className="max-w-24 truncate text-xs"
          >
            {contextWindow}
          </span>
        ) : null}
      </span>
    ),
  };
}

const COLUMN_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";
const COLUMN_LABEL = "px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs";

function ColumnRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  /** The column's one tab stop: the selected level, else the first when none shows as selected. */
  tabStop: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    // Focus lands on a level after a model pick.
    "data-effort-level": true,
    // Up and Down move between rows.
    tabIndex: props.tabStop ? 0 : -1,
    className: COLUMN_ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.selected ? (
        <>
          {props.isDefault ? <span className="sr-only">{tk("common.default")}</span> : null}
          <CheckIcon aria-hidden="true" className="size-3.5" />
        </>
      ) : props.isDefault ? (
        <span className="text-muted-foreground/70 text-xs">{tk("common.default")}</span>
      ) : null}
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-56">
        {props.description}
      </TooltipContent>
    </Tooltip>
  );
}

function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  // An option's side menu is a React child here, but it moves through its own items.
  if (!event.currentTarget.contains(event.target as Node)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next =
    rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView?.({ block: "nearest" });
}

function EffortLevels(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { effort, others } = columnControls(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable) {
    return (
      <>
        {traits.descriptors.map((descriptor) => {
          const value = traits.currentLabel(descriptor);
          return value ? (
            <div key={descriptor.id}>
              <div className={COLUMN_LABEL}>{descriptor.label}</div>
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
            </div>
          ) : null;
        })}
      </>
    );
  }
  if (!effort && others.length === 0) return <NoEffortRow />;
  // Ultrathink in the prompt locks the levels; the first option then holds the tab stop.
  const locked =
    effort?.descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
  return (
    <>
      {effort ? <EffortRows control={effort} traits={traits} locked={locked} /> : null}
      {others.length > 0 ? (
        <div
          className={cn("flex flex-col gap-0.5", effort && "mt-1 border-t border-border/70 pt-1")}
        >
          {others.map((control, index) =>
            control.kind === "boolean" ? (
              <OptionSwitchRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ) : (
              <OptionMenuRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

type TraitsSelection = ReturnType<typeof useTraitsSelection>;

function EffortRows(props: { control: ColumnControl; traits: TraitsSelection; locked: boolean }) {
  const { control, traits } = props;
  const { descriptor } = control;
  if (control.kind === "boolean") {
    return (
      <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
        {([true, false] as const).map((value) => (
          <ColumnRow
            key={String(value)}
            label={value ? tk("modelPicker.on") : tk("modelPicker.off")}
            selected={(control.descriptor.currentValue === true) === value}
            tabStop={(control.descriptor.currentValue === true) === value}
            onPick={() => traits.changeBoolean(descriptor.id, value)}
          />
        ))}
      </div>
    );
  }
  const { locked } = props;
  const value = traits.selectValue(control.descriptor);
  const choices = selectableProviderOptionChoices(control.descriptor);
  // An "Ultrathink:" prefix selects a level the column does not offer.
  const shown = choices.some((option) => option.id === value);
  return (
    <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
      {locked ? (
        <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{ultrathinkInBodyNote()}</div>
      ) : null}
      {choices.map((option, index) => (
        <ColumnRow
          key={option.id}
          label={option.label}
          selected={option.id === value}
          tabStop={shown ? option.id === value : index === 0}
          description={option.description}
          isDefault={option.isDefault}
          disabled={locked}
          onPick={() => traits.changeSelect(control.descriptor, option.id)}
        />
      ))}
    </div>
  );
}

const OPTION_ROW = cn(COLUMN_ROW, "h-auto py-1");

/** An option's name over its current value. */
function OptionRowText(props: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-muted-foreground text-xs">{props.label}</span>
      <span className="truncate">{props.value}</span>
    </span>
  );
}

/**
 * One select besides reasoning, such as an agent's session mode. It names the current choice and
 * opens the rest beside the column, so any number of options leaves the levels in place.
 */
function OptionMenuRow(props: {
  descriptor: SelectDescriptor;
  traits: TraitsSelection;
  /** Holds the column's tab stop when the model has no levels. */
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const [open, setOpen] = useState(false);
  const choices = selectableProviderOptionChoices(descriptor);
  const value = traits.selectValue(descriptor);
  const current = choices.find((choice) => choice.id === value)?.label ?? "";
  return (
    // A modal menu would cover the picker, so the next click there would only close it.
    <DropdownMenu open={open} modal={false} onOpenChange={setOpen}>
      {/* No hover opening: an opened menu takes focus, which would steal typing from search. */}
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            data-effort-row
            tabIndex={props.tabStop ? 0 : -1}
            aria-label={`${descriptor.label}: ${current}`}
            className={cn(OPTION_ROW, "data-[popup-open]:bg-foreground/[0.09]")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          />
        }
      >
        <OptionRowText label={descriptor.label} value={current} />
        <ChevronRightIcon
          aria-hidden="true"
          className="-me-1 size-3.5 shrink-0 text-muted-foreground"
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="right"
        align="start"
        sideOffset={6}
        // A full-width column on phones leaves no room beside it, so fall below or above.
        collisionAvoidance={{ fallbackAxisSide: "end" }}
        className="max-w-72"
        data-model-picker-option-menu
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <DropdownMenu.RadioGroup
          aria-label={descriptor.label}
          value={value}
          onValueChange={(next: string) => {
            if (next !== value) traits.changeSelect(descriptor, next);
          }}
        >
          {choices.map((choice) => (
            <DropdownMenu.RadioItem key={choice.id} value={choice.id} closeOnClick>
              <span className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{choice.label}</span>
                  {choice.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  ) : null}
                </span>
                {choice.isDefault ? (
                  <span className="text-muted-foreground/70 text-xs">{tk("common.default")}</span>
                ) : null}
              </span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** A two-state option toggles in place; a menu would add a click for nothing. */
function OptionSwitchRow(props: {
  descriptor: BooleanDescriptor;
  traits: TraitsSelection;
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const checked = descriptor.currentValue === true;
  return (
    <label className={cn(OPTION_ROW, "has-focus-visible:bg-foreground/[0.09]")}>
      <OptionRowText
        label={descriptor.label}
        value={checked ? tk("modelPicker.on") : tk("modelPicker.off")}
      />
      <Switch
        checked={checked}
        onCheckedChange={(next) => traits.changeBoolean(descriptor.id, next)}
        aria-label={descriptor.label}
        data-effort-row
        tabIndex={props.tabStop ? 0 : -1}
      />
    </label>
  );
}

function NoEffortRow() {
  const { t } = useTranslation("chat");
  return (
    <div className="flex h-8 items-center px-2 text-muted-foreground text-sm">
      {t("modelPicker.noEffortLevels")}
    </div>
  );
}

/** The model picker's effort column: the selected model's levels and its other options. */
export function ComposerEffortColumn(props: {
  traits: TraitsSelectionInput | null;
  /** Why the levels are not shown yet (still loading, a switch in flight). */
  unavailableReason?: string | undefined;
}) {
  const { t } = useTranslation("chat");
  const picker = use(DockedPickerContext);
  const visibility = props.traits ? getTraitsSectionVisibility(props.traits) : null;
  const controls =
    props.traits && visibility
      ? columnControls(visibility.selectDescriptors, visibility.booleanDescriptors)
      : null;
  return (
    <>
      {/* Matches the search row's box, so one rule runs across the top of the popup. */}
      <div className="shrink-0 px-3 pt-1">
        <div className="flex h-8 items-center gap-2 border-b border-border/70 text-sm">
          <span className="text-muted-foreground">
            {controls?.effort?.descriptor.label ??
              (controls?.others.length ? t("modelPicker.options") : t("modelPicker.effort"))}
          </span>
          <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
            {picker.modelLabel}
          </span>
        </div>
      </div>
      {/* pt-2.5 puts the first level on the same line as the first model. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2 pb-1.5"
        // Capture, so Up and Down on an option row move rows instead of opening its menu.
        onKeyDownCapture={moveBetweenRows}
      >
        {props.traits ? (
          <EffortLevels traits={props.traits} />
        ) : props.unavailableReason ? (
          <div role="status" className="px-2 py-1.5 text-muted-foreground text-xs">
            {props.unavailableReason}
          </div>
        ) : (
          <NoEffortRow />
        )}
      </div>
    </>
  );
}

const FOOTER_SEGMENT =
  "flex h-6 cursor-pointer items-center justify-center gap-1 px-2 text-muted-foreground text-xs outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground data-[checked]:bg-fill-active data-[checked]:text-foreground focus-visible:ring-2 focus-visible:ring-border focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  /** Draws the bolt before the label. */
  fast?: "fast" | "ultrafast" | undefined;
  description?: string | undefined;
  onPick: () => void;
}) {
  const buttonProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.checked,
    "data-checked": props.checked || undefined,
    className: FOOTER_SEGMENT,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {props.fast ? <FastBolt ultra={props.fast === "ultrafast"} /> : null}
      {props.label}
    </>
  );
  if (!props.description) return <button {...buttonProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipContent side="top">{props.description}</TooltipContent>
    </Tooltip>
  );
}

function SpeedControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || (!speedSelect && !fastToggle)) return null;
  return (
    <div
      role="radiogroup"
      aria-label={speedSelect?.label ?? fastToggle?.label}
      className="flex rounded-lg bg-fill-subtle p-0.5"
    >
      {speedSelect
        ? selectableProviderOptionChoices(speedSelect).map((option) => (
            <SpeedSegment
              key={option.id}
              checked={option.id === traits.selectValue(speedSelect)}
              label={option.label}
              fast={
                option.label === "Fast"
                  ? "fast"
                  : option.label === "Ultrafast"
                    ? "ultrafast"
                    : undefined
              }
              description={option.description}
              onPick={() => traits.changeSelect(speedSelect, option.id)}
            />
          ))
        : fastToggle
          ? ([false, true] as const).map((value) => (
              <SpeedSegment
                key={String(value)}
                checked={(fastToggle.currentValue === true) === value}
                label={value ? tk("modelPicker.fast") : tk("modelPicker.standard")}
                fast={value ? "fast" : undefined}
                onPick={() => traits.changeBoolean(fastToggle.id, value)}
              />
            ))
          : null}
    </div>
  );
}

/** The context window, one click away like speed: its choices are few and change the price. */
function ContextWindowControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { contextWindowSelect } = splitSpeed(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable || !contextWindowSelect) return null;
  return (
    <div
      role="radiogroup"
      aria-label={contextWindowSelect.label}
      className="flex rounded-lg bg-fill-subtle p-0.5"
    >
      {selectableProviderOptionChoices(contextWindowSelect).map((option) => (
        <SpeedSegment
          key={option.id}
          checked={option.id === traits.selectValue(contextWindowSelect)}
          label={option.label}
          description={option.description}
          onPick={() => traits.changeSelect(contextWindowSelect, option.id)}
        />
      ))}
    </div>
  );
}

function UltracodeControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { ultracodeToggle } = splitSpeed(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable || !ultracodeToggle) return null;
  const on = ultracodeToggle.currentValue === true;
  return (
    <div className="flex rounded-lg bg-fill-subtle p-0.5">
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        className={FOOTER_SEGMENT}
        onClick={() => traits.changeBoolean(ultracodeToggle.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {ultracodeToggle.label}
      </button>
    </div>
  );
}

/** Where the selection comes from: this session's own pick, or the Factory's default. */
export interface SelectionOrigin {
  source: string;
  setForSession: boolean;
  onUseDefault?: (() => void) | undefined;
}

function OriginNote(props: { origin: SelectionOrigin }) {
  const { t } = useTranslation("chat");
  const { origin } = props;
  if (!origin.setForSession || !origin.onUseDefault) {
    return (
      <span className="ms-auto text-muted-foreground text-xs">
        {t("thinking.follows", { source: origin.source })}
      </span>
    );
  }
  return (
    <span className="ms-auto flex items-center gap-2">
      <span className="text-muted-foreground text-xs">{t("thinking.setForSession")}</span>
      <Button variant="ghost" size="sm" onClick={origin.onUseDefault}>
        {t("thinking.useDefault")}
      </Button>
    </span>
  );
}

/** The model picker's footer: speed and the context window stay one click away. */
export function ComposerPickerFooter(props: {
  traits: TraitsSelectionInput | null;
  origin: SelectionOrigin | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2">
      {props.traits ? <SpeedControl traits={props.traits} /> : null}
      {props.traits ? <ContextWindowControl traits={props.traits} /> : null}
      {props.traits ? <UltracodeControl traits={props.traits} /> : null}
      {props.origin ? <OriginNote origin={props.origin} /> : null}
    </div>
  );
}
