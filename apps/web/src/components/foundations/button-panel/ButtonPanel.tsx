import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export type ButtonPanelProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

export const ButtonPanel = forwardRef<HTMLButtonElement, ButtonPanelProps>(function ButtonPanel(
  { "aria-label": ariaLabel = "Toggle panel", className, type = "button", ...props },
  ref,
) {
  return (
    <button
      aria-label={ariaLabel}
      className={cn(
        "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] outline-none transition-colors hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:text-[var(--color-text-foreground-tertiary)]",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    >
      <svg aria-hidden="true" className="size-4" fill="currentColor" viewBox="0 0 14 14">
        <path d="M2.60449 1.20313q-.50586.08545-.87842.43749-.36914.34863-.50927.86475-.02734.08545-.02735.71436L1.17578 7l.01367 3.78027q0 .62891.02735.71436.14014.48877.46826.82031.33154.32813.82031.46826.08545.02734.71436.02735L7 12.82422l3.78027-.01367q.62891 0 .71436-.02735.48877-.14014.81689-.46826.33154-.33154.47168-.82031.02734-.08545.02735-.71436L12.82422 7l-.01367-3.78027q0-.62891-.02735-.71436-.12646-.48877-.458-.81689-.32813-.33154-.80323-.47168l-.14013-.04102H7.05469q-4.3374 0-4.4502.02734ZM8.17578 7v4.67578H5.54395q-2.63184 0-2.73096-.02734-.29395-.05811-.43408-.33496l-.04102-.09913V2.78564l.04102-.09912q.07178-.14014.18798-.229.11963-.09229.25977-.11963.08545 0 2.71729-.01367h2.63183V7Zm3.1377-4.62109q.2085.09912.30761.30761l.04102.09912v8.42871l-.04102.09913q-.14014.27685-.43408.33496-.09912.02734-.98096.02734h-.88183V2.32422l1.89013.01367.09913.04102Z" />
      </svg>
    </button>
  );
});
