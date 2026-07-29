import { IconFileText, IconX } from "@tabler/icons-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface PanelTabSharedProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  icon?: ReactNode;
  onClose?: () => void;
}

export const PanelTabShared = forwardRef<HTMLButtonElement, PanelTabSharedProps>(
  function PanelTabShared(
    { active = false, children = "Files", className, icon = <IconFileText />, onClose, ...props },
    ref,
  ) {
    return (
      <div
        data-pencil-component="nyAGp"
        className={cn(
          "group/panel-tab flex h-8 items-center gap-1.5 rounded-t-md px-3 font-sans text-[13px] text-[var(--color-text-foreground-secondary)] transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
          active &&
            "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]",
          className,
        )}
      >
        <button
          aria-selected={active}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-inherit outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
          ref={ref}
          role="tab"
          type="button"
          {...props}
        >
          <span className="inline-flex size-3.5 items-center justify-center [&_svg]:size-3.5">
            {icon}
          </span>
          <span className="truncate">{children}</span>
        </button>
        {onClose ? (
          <button
            aria-label={`Close ${String(children)}`}
            className="inline-flex size-3 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit opacity-0 outline-none group-hover/panel-tab:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
            onClick={onClose}
            type="button"
          >
            <IconX className="size-3" />
          </button>
        ) : null}
      </div>
    );
  },
);
