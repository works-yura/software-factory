// Minimal tooltip, menu and popover. Popups portal
// to the body with fixed positioning beside their trigger, so scrolling rails
// do not clip them. The `render` prop keeps Base UI's call shape: the trigger
// element is cloned with the trigger's props.
import {
  cloneElement,
  createContext,
  isValidElement,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn.ts";
import { Check } from "./icons.tsx";

export type Side = "left" | "right" | "top" | "bottom";
export type Align = "start" | "center" | "end";

function floatingStyle(anchor: Element | null, side: Side, align: Align, offset = 8) {
  const style: CSSProperties = { position: "fixed" };
  if (!anchor || typeof window === "undefined") return style;
  const rect = anchor.getBoundingClientRect();
  const { innerWidth, innerHeight } = window;
  const transforms: string[] = [];
  if (side === "left" || side === "right") {
    if (side === "left") style.right = innerWidth - rect.left + offset;
    else style.left = rect.right + offset;
    if (align === "start") style.top = rect.top;
    else if (align === "end") style.bottom = innerHeight - rect.bottom;
    else {
      style.top = rect.top + rect.height / 2;
      transforms.push("translateY(-50%)");
    }
  } else {
    if (side === "bottom") style.top = rect.bottom + offset;
    else style.bottom = innerHeight - rect.top + offset;
    if (align === "start") style.left = rect.left;
    else if (align === "end") style.right = innerWidth - rect.right;
    else {
      style.left = rect.left + rect.width / 2;
      transforms.push("translateX(-50%)");
    }
  }
  if (transforms.length > 0) style.transform = transforms.join(" ");
  return style;
}

/** Closes on Escape and on a press outside the trigger and popup. */
function useDismiss(
  open: boolean,
  close: () => void,
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (refs.some((ref) => ref.current && target && ref.current.contains(target))) return;
      closeRef.current();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
    // The refs are stable objects owned by the caller; only opening and closing resubscribes.
  }, [open]);
}

type TriggerProps = Record<string, unknown>;

/** Clones `render` (or a plain button) with the trigger's props, composing event handlers. */
function renderTrigger(
  render: ReactElement | undefined,
  props: TriggerProps,
  children: ReactNode,
  fallback: "button" | "span" = "button",
) {
  if (render && isValidElement<TriggerProps>(render)) {
    const merged: TriggerProps = { ...props };
    for (const [key, value] of Object.entries(props)) {
      const own = render.props[key];
      if (key.startsWith("on") && typeof own === "function" && typeof value === "function") {
        merged[key] = (...args: unknown[]) => {
          (own as (...a: unknown[]) => void)(...args);
          (value as (...a: unknown[]) => void)(...args);
        };
      }
    }
    return children === undefined
      ? cloneElement(render, merged)
      : cloneElement(render, merged, children);
  }
  return fallback === "button" ? (
    <button type="button" {...props}>
      {children}
    </button>
  ) : (
    <span {...props}>{children}</span>
  );
}

// Tooltip

interface TooltipValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly id: string;
  readonly triggerRef: RefObject<HTMLElement | null>;
}
const TooltipContext = createContext<TooltipValue | null>(null);

export function Tooltip(props: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  return <TooltipContext value={{ open, setOpen, id, triggerRef }}>{props.children}</TooltipContext>;
}

export function TooltipTrigger(props: {
  readonly render?: ReactElement;
  readonly children?: ReactNode;
}) {
  const context = use(TooltipContext);
  if (!context) throw new Error("TooltipTrigger must be inside Tooltip");
  const show = () => context.setOpen(true);
  const hide = () => context.setOpen(false);
  return renderTrigger(
    props.render,
    {
      ref: context.triggerRef,
      "aria-describedby": context.open ? context.id : undefined,
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
    },
    props.children,
    "span",
  );
}

export function TooltipPopup(props: {
  readonly side?: Side;
  readonly align?: Align;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const context = use(TooltipContext);
  if (!context?.open || typeof document === "undefined") return null;
  return createPortal(
    <div
      id={context.id}
      role="tooltip"
      data-slot="tooltip-popup"
      style={floatingStyle(context.triggerRef.current, props.side ?? "top", props.align ?? "center")}
      className={cn(
        "pointer-events-none z-[140] flex max-w-80 wrap-anywhere whitespace-normal rounded-md border bg-popover px-2 py-1 text-xs leading-snug text-balance text-foreground shadow-md/5",
        props.className,
      )}
    >
      {props.children}
    </div>,
    document.body,
  );
}

// Menu

interface MenuValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly id: string;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly popupRef: RefObject<HTMLDivElement | null>;
}
const MenuContext = createContext<MenuValue | null>(null);

export function Menu(props: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, () => setOpen(false), [triggerRef, popupRef]);
  return (
    <MenuContext value={{ open, setOpen, id, triggerRef, popupRef }}>{props.children}</MenuContext>
  );
}

function useMenu() {
  const context = use(MenuContext);
  if (!context) throw new Error("Menu parts must be inside Menu");
  return context;
}

export function MenuTrigger(props: { readonly render?: ReactElement; readonly children?: ReactNode }) {
  const menu = useMenu();
  return renderTrigger(
    props.render,
    {
      ref: menu.triggerRef,
      "aria-haspopup": "menu",
      "aria-expanded": menu.open,
      "aria-controls": menu.open ? menu.id : undefined,
      "data-popup-open": menu.open ? "" : undefined,
      onClick: () => menu.setOpen(!menu.open),
    },
    props.children,
  );
}

const menuItems = (popup: HTMLElement | null) =>
  Array.from(
    popup?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
    ) ?? [],
  );

export function MenuPopup(props: {
  readonly side?: Side;
  readonly align?: Align;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const menu = useMenu();
  // moves focus into a menu as it opens
  useEffect(() => {
    if (menu.open) menuItems(menu.popupRef.current)[0]?.focus();
  }, [menu.open, menu.popupRef]);
  if (!menu.open || typeof document === "undefined") return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menu.popupRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      menu.setOpen(false);
      menu.triggerRef.current?.focus();
    }
  };
  return createPortal(
    <div
      ref={menu.popupRef}
      id={menu.id}
      role="menu"
      data-slot="menu-popup"
      style={floatingStyle(menu.triggerRef.current, props.side ?? "bottom", props.align ?? "start")}
      className={cn(
        "dropdown-glass z-[130] flex max-w-[calc(100vw-2rem)] min-w-[min(10rem,calc(100vw-2rem))] flex-col rounded-lg border bg-popover p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
        props.className,
      )}
      onKeyDown={onKeyDown}
    >
      {props.children}
    </div>,
    document.body,
  );
}

const menuItemClassName =
  "[&>svg]:-mx-0.5 flex min-h-8 w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-base text-foreground outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-64 data-[variant=destructive]:text-destructive-foreground sm:min-h-7 sm:text-sm [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current [&>svg]:pointer-events-none [&>svg]:shrink-0";

export function MenuItem(props: {
  readonly variant?: "default" | "destructive";
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const menu = useMenu();
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      data-slot="menu-item"
      data-variant={props.variant ?? "default"}
      disabled={props.disabled}
      className={menuItemClassName}
      onClick={() => {
        menu.setOpen(false);
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="mx-2 my-1 h-px bg-border" />;
}

interface MenuRadioValue {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}
const MenuRadioContext = createContext<MenuRadioValue | null>(null);
const MenuRadioItemContext = createContext(false);

export function MenuRadioGroup(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <div role="group">
      <MenuRadioContext value={{ value: props.value, onValueChange: props.onValueChange }}>
        {props.children}
      </MenuRadioContext>
    </div>
  );
}

export function MenuRadioItem(props: { readonly value: string; readonly children: ReactNode }) {
  const menu = useMenu();
  const group = use(MenuRadioContext);
  const checked = group?.value === props.value;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-checked={checked ? "" : undefined}
      tabIndex={-1}
      className={cn(
        menuItemClassName.replace("[&>svg:not([class*='text-'])]:text-muted-foreground ", ""),
        "data-checked:bg-foreground/[0.08]",
      )}
      onClick={() => {
        menu.setOpen(false);
        group?.onValueChange(props.value);
      }}
    >
      <span className="min-w-0 flex-1">
        <MenuRadioItemContext value={checked}>{props.children}</MenuRadioItemContext>
      </span>
    </button>
  );
}

export function MenuRadioItemIndicator() {
  const checked = use(MenuRadioItemContext);
  return <span className="flex size-3.5 shrink-0">{checked ? <Check className="size-3.5" /> : null}</span>;
}

// Popover

interface PopoverValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly id: string;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly popupRef: RefObject<HTMLDivElement | null>;
}
const PopoverContext = createContext<PopoverValue | null>(null);

export function Popover(props: {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = props.open ?? uncontrolled;
  const setOpen = (next: boolean) => {
    setUncontrolled(next);
    props.onOpenChange?.(next);
  };
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, () => setOpen(false), [triggerRef, popupRef]);
  return (
    <PopoverContext value={{ open, setOpen, id, triggerRef, popupRef }}>
      {props.children}
    </PopoverContext>
  );
}

function usePopover() {
  const context = use(PopoverContext);
  if (!context) throw new Error("Popover parts must be inside Popover");
  return context;
}

export function PopoverTrigger(props: {
  readonly render?: ReactElement;
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
}) {
  const popover = usePopover();
  return renderTrigger(
    props.render,
    {
      ref: popover.triggerRef,
      "aria-label": props["aria-label"],
      "aria-haspopup": "dialog",
      "aria-expanded": popover.open,
      "aria-controls": popover.open ? popover.id : undefined,
      "data-popup-open": popover.open ? "" : undefined,
      onClick: () => popover.setOpen(!popover.open),
    },
    props.children,
  );
}

const popoverWidths = { md: "w-80", lg: "w-96" } as const;

export function PopoverPopup(props: {
  readonly side?: Side;
  readonly align?: Align;
  readonly width?: keyof typeof popoverWidths;
  readonly padding?: "default" | "compact";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const popover = usePopover();
  if (!popover.open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popover.popupRef}
      id={popover.id}
      role="dialog"
      data-slot="popover-popup"
      style={floatingStyle(
        popover.triggerRef.current,
        props.side ?? "bottom",
        props.align ?? "center",
      )}
      className={cn(
        "dropdown-glass z-[130] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border bg-popover text-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
        props.width && popoverWidths[props.width],
        props.padding === "compact" ? "px-3 py-2" : "p-4",
        props.className,
      )}
    >
      {props.children}
    </div>,
    document.body,
  );
}
