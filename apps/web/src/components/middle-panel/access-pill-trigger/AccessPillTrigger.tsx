import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

import { AccessPillContent } from "../access-pill-content/AccessPillContent";

export interface AccessPillTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
}

export const AccessPillTrigger = forwardRef<HTMLButtonElement, AccessPillTriggerProps>(
  function AccessPillTrigger({ className, label = "Full access", type = "button", ...props }, ref) {
    return (
      <button
        className={cn(
          "inline-flex h-[26px] cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-1.5 font-sans text-xs text-orange-500 outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]",
          className,
        )}
        data-pencil-component="iP6oE"
        ref={ref}
        type={type}
        {...props}
      >
        <AccessPillContent label={label} />
      </button>
    );
  },
);
