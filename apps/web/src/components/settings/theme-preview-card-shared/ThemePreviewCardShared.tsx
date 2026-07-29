import type { ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export interface ThemePreviewCardSharedProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
  mode?: "dark" | "light";
  selected?: boolean;
}

export function ThemePreviewCardShared({
  className,
  label = "Light",
  mode = "light",
  selected = false,
  ...props
}: ThemePreviewCardSharedProps) {
  const dark = mode === "dark";
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex w-[140px] cursor-pointer flex-col gap-2 border-0 bg-transparent p-0 text-center font-sans outline-none",
        className,
      )}
      type="button"
      {...props}
      data-pencil-component="YjdYo"
    >
      <span
        className={cn(
          "relative block h-[100px] w-[140px] overflow-hidden rounded-[10px] border bg-[#f4f5f7]",
          dark && "bg-[#1b1d23]",
          selected
            ? "border-[var(--color-border-focus)] ring-1 ring-[var(--color-border-focus)]"
            : "border-[var(--color-border)]",
        )}
      >
        <span className="absolute left-2.5 top-2.5 h-1 w-9 rounded-sm bg-black/15" />
        <span className="absolute left-2.5 top-5 h-1 w-[52px] rounded-sm bg-black/15" />
        <span
          className={cn(
            "absolute inset-x-3.5 bottom-2.5 flex h-14 flex-col gap-1.5 rounded-md border border-black/10 bg-white p-2",
            dark && "border-white/10 bg-[#272a33]",
          )}
        >
          <span className={cn("h-1 w-[60px] rounded-sm bg-black/15", dark && "bg-white/20")} />
          <span className={cn("h-1 w-20 rounded-sm bg-black/15", dark && "bg-white/20")} />
          <span className={cn("h-1 w-11 rounded-sm bg-black/15", dark && "bg-white/20")} />
        </span>
      </span>
      <span className="text-[13px] font-semibold text-[var(--color-text-foreground)]">
        {label}
      </span>
    </button>
  );
}
