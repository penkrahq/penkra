import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface InputSharedProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  leadingIcon?: ReactNode;
  invalid?: boolean;
}

export const InputShared = forwardRef<HTMLInputElement, InputSharedProps>(function InputShared(
  {
    "aria-invalid": ariaInvalid,
    className,
    disabled,
    invalid = false,
    leadingIcon,
    ...props
  },
  ref,
) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";

  return (
    <label
      className={cn(
        "group/input-shared flex h-[43px] w-full items-center gap-2 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] px-4 text-[var(--color-text-foreground-tertiary)] transition-colors",
        "hover:border-[var(--color-border-heavy)] hover:text-[var(--color-text-foreground-secondary)]",
        "focus-within:!border-[var(--color-border-focus)] focus-within:!text-[var(--color-text-foreground)]",
        isInvalid && "border-destructive text-[var(--color-text-foreground)]",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      data-slot="input-shared"
    >
      {leadingIcon ? (
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <input
        aria-invalid={isInvalid || undefined}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-sm font-normal text-[var(--color-text-foreground)] outline-none placeholder:text-current placeholder:opacity-100 disabled:cursor-not-allowed"
        disabled={disabled}
        ref={ref}
        {...props}
      />
    </label>
  );
});
