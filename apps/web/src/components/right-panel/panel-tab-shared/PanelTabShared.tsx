import { IconFileText, IconX } from "@tabler/icons-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode, useState } from "react";

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
    const [hovered, setHovered] = useState(false);
    const [closePressed, setClosePressed] = useState(false);
    const [closeFocused, setCloseFocused] = useState(false);
    const showClose = Boolean(onClose) && (hovered || closePressed || closeFocused);

    return (
      <div
        data-pencil-component="nyAGp"
        className={cn(
          "relative h-8 rounded-lg font-sans text-[length:var(--app-font-size-ui-lg,13px)] text-[var(--color-text-foreground-secondary)] transition-colors select-none hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] [-webkit-app-region:no-drag]",
          active &&
            "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]",
          className,
        )}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <button
          aria-selected={active}
          className="flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-3 py-0 text-inherit outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] [-webkit-app-region:no-drag]"
          ref={ref}
          role="tab"
          type="button"
          {...props}
        >
          <span
            className={cn(
              "inline-flex size-3.5 items-center justify-center transition-opacity [&_svg]:size-3.5",
              showClose && "opacity-0",
            )}
          >
            {icon}
          </span>
          <span className="truncate">{children}</span>
        </button>
        {onClose ? (
          <button
            aria-label={`Close ${String(children)}`}
            className={cn(
              "pointer-events-none absolute left-3 top-1/2 z-10 inline-flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-inherit opacity-0 outline-none transition-[background-color,opacity] hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] [-webkit-app-region:no-drag]",
              showClose && "pointer-events-auto opacity-100",
            )}
            onClick={(event) => {
              event.stopPropagation();
              setClosePressed(false);
              onClose();
            }}
            onBlur={() => setCloseFocused(false)}
            onFocus={() => setCloseFocused(true)}
            onPointerCancel={(event) => {
              setClosePressed(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              setClosePressed(true);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            type="button"
          >
            <IconX className="size-3" />
          </button>
        ) : null}
      </div>
    );
  },
);
