import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export type LeftRailRowState =
  | "default"
  | "hover"
  | "active"
  | "selected"
  | "open"
  | "disabled"
  | "focus"
  | "error";

export interface LeftRailRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  leading?: ReactNode;
  leadingClassName?: string;
  labelClassName?: string;
  state?: LeftRailRowState;
  trailing?: ReactNode;
  trailingClassName?: string;
}

export interface LeftRailRowFrameProps extends HTMLAttributes<HTMLDivElement> {
  leading?: ReactNode;
  leadingClassName?: string;
  labelClassName?: string;
  state?: LeftRailRowState;
  trailing?: ReactNode;
  trailingClassName?: string;
}

function leftRailRowClassName(input: {
  className?: string | undefined;
  disabled?: boolean | undefined;
  state: LeftRailRowState;
}) {
  return cn(
    "group/left-rail-row flex h-[27px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 font-sans text-[length:var(--app-font-size-ui,12px)] leading-4 font-normal text-[var(--color-text-foreground-secondary)] outline-none transition-colors",
    "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] active:bg-transparent active:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
    input.state === "hover" &&
      "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)]",
    (input.state === "active" || input.state === "selected") &&
      "bg-transparent text-[var(--color-text-foreground)]",
    input.state === "open" && "text-[var(--color-text-foreground-secondary)]",
    (input.disabled || input.state === "disabled") &&
      "cursor-not-allowed bg-transparent text-[var(--color-text-foreground-tertiary)] hover:bg-transparent hover:text-[var(--color-text-foreground-tertiary)]",
    input.state === "focus" &&
      "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)] ring-1 ring-[var(--color-border-focus)]",
    input.state === "error" &&
      "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)] ring-1 ring-destructive",
    input.className,
  );
}

function LeftRailRowContent(props: {
  children: ReactNode;
  leading?: ReactNode;
  leadingClassName?: string | undefined;
  labelClassName?: string | undefined;
  trailing?: ReactNode;
  trailingClassName?: string | undefined;
}) {
  return (
    <>
      {props.leading ? (
        <span
          className={cn(
            "inline-flex size-4 shrink-0 items-center justify-center",
            props.leadingClassName,
          )}
          data-slot="left-rail-leading"
        >
          {props.leading}
        </span>
      ) : null}
      <span
        className={cn("min-w-0 flex-1 truncate text-left", props.labelClassName)}
        data-slot="left-rail-label"
      >
        {props.children}
      </span>
      {props.trailing ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center",
            props.trailingClassName,
          )}
          data-slot="left-rail-trailing"
        >
          {props.trailing}
        </span>
      ) : null}
    </>
  );
}

export const LeftRailRowFrame = forwardRef<HTMLDivElement, LeftRailRowFrameProps>(
  function LeftRailRowFrame(
    {
      children,
      className,
      leading,
      leadingClassName,
      labelClassName,
      state = "default",
      trailing,
      trailingClassName,
      ...props
    },
    ref,
  ) {
    return (
      <div
        className={leftRailRowClassName({ className, state })}
        data-state={state}
        ref={ref}
        {...props}
      >
        <LeftRailRowContent
          leading={leading}
          leadingClassName={leadingClassName}
          labelClassName={labelClassName}
          trailing={trailing}
          trailingClassName={trailingClassName}
        >
          {children}
        </LeftRailRowContent>
      </div>
    );
  },
);

export const LeftRailRow = forwardRef<HTMLButtonElement, LeftRailRowProps>(function LeftRailRow(
  {
    children,
    className,
    disabled,
    leading,
    leadingClassName,
    labelClassName,
    state = "default",
    trailing,
    trailingClassName,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      className={leftRailRowClassName({ className, disabled, state })}
      data-state={state}
      disabled={disabled || state === "disabled"}
      ref={ref}
      type={type}
      {...props}
    >
      <LeftRailRowContent
        leading={leading}
        leadingClassName={leadingClassName}
        labelClassName={labelClassName}
        trailing={trailing}
        trailingClassName={trailingClassName}
      >
        {children}
      </LeftRailRowContent>
    </button>
  );
});
