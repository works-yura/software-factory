// Minimal stand-ins for t3code's spinner, switch, input, toggle group, select,
// collapsible and discovery list: plain elements, the original class names.
import {
  createContext,
  use,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "./cn.ts";
import { ChevronDown, LoaderCircle } from "./icons.tsx";

const spinnerSizes = { xs: "size-3", sm: "size-3.5", md: "size-4", lg: "size-5" } as const;

export function Spinner({
  className,
  size,
}: {
  readonly className?: string;
  readonly size?: keyof typeof spinnerSizes;
}) {
  return (
    <LoaderCircle
      aria-label="Loading"
      role="status"
      className={cn("motion-safe:animate-spin", size && spinnerSizes[size], className)}
    />
  );
}

export function Switch({
  className,
  size = "default",
  checked,
  disabled,
  onCheckedChange,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "role"> & {
  readonly size?: "default" | "sm";
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-checked={checked ? "" : undefined}
      data-unchecked={checked ? undefined : ""}
      data-disabled={disabled ? "" : undefined}
      data-size={size}
      data-slot="switch"
      className={cn(
        "inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-fill-inverse data-unchecked:bg-border data-disabled:cursor-not-allowed data-disabled:opacity-64",
        size === "sm"
          ? "[--thumb-size:--spacing(4)] sm:[--thumb-size:--spacing(3.5)]"
          : "[--thumb-size:--spacing(5)] sm:[--thumb-size:--spacing(4)]",
        className,
      )}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span
        data-checked={checked ? "" : undefined}
        data-unchecked={checked ? undefined : ""}
        data-slot="switch-thumb"
        className="pointer-events-none block size-[calc(var(--thumb-size)-2px)] shrink-0 origin-left rounded-(--thumb-size) bg-background shadow-sm/5 dark:data-unchecked:bg-muted-foreground [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-right data-checked:translate-x-[calc(var(--thumb-size)-4px)]"
      />
    </button>
  );
}

export function Input({
  className,
  size = "default",
  font = "default",
  ...props
}: Omit<ComponentProps<"input">, "size"> & {
  readonly size?: "default" | "compact";
  readonly font?: "default" | "mono";
}) {
  return (
    <span
      data-size={size}
      data-slot="input-control"
      className={cn(
        "relative inline-flex w-full rounded-lg border border-border bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-border-focus/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] has-focus-visible:border-border-focus has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] has-focus-visible:ring-inset sm:text-sm dark:bg-border/32",
        size === "compact" && "rounded-md before:rounded-[calc(var(--radius-md)-1px)]",
        font === "mono" && "font-mono tabular-nums",
        className,
      )}
    >
      <input
        data-slot="input"
        className={cn(
          "h-8.5 w-full min-w-0 rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5",
          size === "compact" &&
            "h-7 px-[calc(--spacing(2.5)-1px)] text-xs leading-7 sm:h-7 sm:leading-7",
        )}
        {...props}
      />
    </span>
  );
}

interface ToggleGroupValue {
  readonly value: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onValueChange: (value: string[]) => void;
}
const ToggleGroupContext = createContext<ToggleGroupValue | null>(null);

/** Single-select, like Base UI's default: pressing the pressed toggle clears the value. */
export function ToggleGroup(props: {
  readonly "aria-label": string;
  readonly value: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onValueChange: (value: string[]) => void;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={props["aria-label"]}
      data-slot="toggle-group"
      data-variant="segmented"
      className="flex w-fit gap-0.5 rounded-lg bg-border/40 p-0.5 *:focus-visible:z-10"
    >
      <ToggleGroupContext
        value={{
          value: props.value,
          disabled: props.disabled === true,
          onValueChange: props.onValueChange,
        }}
      >
        {props.children}
      </ToggleGroupContext>
    </div>
  );
}

export function Toggle(props: { readonly value: string; readonly children: ReactNode }) {
  const group = use(ToggleGroupContext);
  const pressed = group?.value.includes(props.value) ?? false;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-pressed={pressed ? "" : undefined}
      data-slot="toggle"
      disabled={group?.disabled}
      className="relative inline-flex h-6 min-w-0 shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent px-2.5 text-xs font-medium text-muted-foreground shadow-none outline-none transition-colors hover:bg-background/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus disabled:pointer-events-none disabled:opacity-64 data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-xs/10 dark:hover:bg-border/32 dark:data-pressed:bg-border/72"
      onClick={() => group?.onValueChange(pressed ? [] : [props.value])}
    >
      {props.children}
    </button>
  );
}

/**
 * A native <select> styled like t3code's select trigger. A null value shows the
 * placeholder; picking an option reports it and the parent decides the value.
 */
export function Select<V extends string>(props: {
  readonly "aria-label": string;
  readonly value: V | null;
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onValueChange: (value: V) => void;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <span className={cn("relative inline-flex", props.className)}>
      <select
        aria-label={props["aria-label"]}
        data-slot="select-trigger"
        value={current ? current.value : ""}
        disabled={props.disabled}
        className={cn(
          "relative inline-flex h-7 w-full cursor-pointer appearance-none select-none items-center rounded-md border border-border bg-background ps-[calc(--spacing(2)-1px)] pe-6 text-left text-sm text-foreground shadow-xs/5 outline-none focus-visible:border-border-focus focus-visible:ring-[3px] focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 sm:h-6 sm:text-xs dark:bg-border/32",
          !current && "text-muted-foreground",
        )}
        onChange={(event) => {
          const option = props.options.find((candidate) => candidate.value === event.target.value);
          if (option) props.onValueChange(option.value);
        }}
      >
        <option value="" disabled hidden>
          {props.placeholder ?? "Unknown"}
        </option>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 opacity-70"
      />
    </span>
  );
}

interface CollapsibleValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly panelId: string;
}
const CollapsibleContext = createContext<CollapsibleValue | null>(null);

export function Collapsible(props: {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const panelId = useId();
  const open = props.open ?? uncontrolled;
  const setOpen = (next: boolean) => {
    setUncontrolled(next);
    props.onOpenChange?.(next);
  };
  return (
    <div data-slot="collapsible">
      <CollapsibleContext value={{ open, setOpen, panelId }}>{props.children}</CollapsibleContext>
    </div>
  );
}

export function CollapsibleTrigger(props: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const context = use(CollapsibleContext);
  return (
    <button
      type="button"
      aria-expanded={context?.open ?? false}
      aria-controls={context?.open ? context.panelId : undefined}
      className={props.className}
      onClick={() => context?.setOpen(!context.open)}
    >
      {props.children}
    </button>
  );
}

/** Unmounts while closed, as Base UI's collapsible panel does by default. */
export function CollapsiblePanel(props: { readonly children: ReactNode }) {
  const context = use(CollapsibleContext);
  if (!context?.open) return null;
  return <div id={context.panelId}>{props.children}</div>;
}

export function DiscoveryList({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
      {children}
    </div>
  );
}
