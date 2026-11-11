// Minimal setup wizard. The standalone panel shows it inline, so WizardPopup is a card, not a dialog.
import { useId, type ReactNode } from "react";
import { cn } from "./cn.ts";
import { Check } from "./icons.tsx";

export function WizardPopup(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className="flex size-full min-h-0 overflow-y-auto p-4">
      <div
        className={cn(
          "m-auto flex w-full max-w-xl min-h-0 flex-col overflow-hidden rounded-2xl border bg-popover text-foreground shadow-lg/5",
          props.className,
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

export function WizardHeader(props: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 p-6 pb-3" aria-labelledby={id} role="group">
      <h2 id={id} className="font-heading text-xl leading-none font-semibold">
        {props.title}
      </h2>
      {props.description ? (
        <p className="text-sm text-muted-foreground">{props.description}</p>
      ) : null}
      {props.children}
    </div>
  );
}

export function WizardFooter(props: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2 px-6 py-4 sm:flex-row sm:justify-end">
      {props.children}
    </div>
  );
}

export function WizardSteps({
  steps,
  currentStep,
  onStepChange,
  isStepDisabled,
}: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly isStepDisabled?: (step: number) => boolean;
  readonly onStepChange?: (step: number) => void;
}) {
  const Step = onStepChange ? "button" : "div";
  return (
    <ol
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-background p-1 ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/5"
      aria-label="Setup progress"
    >
      {steps.map((step, index) => (
        <li key={step} className="min-w-0">
          <Step
            {...(onStepChange
              ? { type: "button" as const, disabled: isStepDisabled?.(index) }
              : {})}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus max-sm:justify-center max-sm:px-2",
              onStepChange &&
                "cursor-pointer hover:bg-card disabled:cursor-default disabled:hover:bg-transparent",
              index === currentStep &&
                "bg-card text-foreground shadow-xs ring-1 ring-inset ring-black/5 hover:bg-card dark:shadow-none dark:ring-white/5",
            )}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}`}
            onClick={onStepChange ? () => onStepChange(index) : undefined}
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-sm font-medium ring-1",
                index < currentStep
                  ? "bg-fill-inverse text-background ring-fill-inverse"
                  : index === currentStep
                    ? "bg-fill-inverse/10 text-fill-inverse ring-fill-inverse/30"
                    : "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
              )}
              aria-hidden
            >
              {index < currentStep ? <Check className="size-4 shrink-0" /> : index + 1}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-sm font-medium max-sm:hidden",
                index === currentStep ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step}
            </span>
          </Step>
        </li>
      ))}
    </ol>
  );
}

export function WizardPanel(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div
      data-slot="dialog-panel"
      className={cn(
        "min-w-0 space-y-4 bg-background/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
