import { IconWorld } from "@tabler/icons-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { IconTileApp } from "../icon-tile-app/IconTileApp";

export interface LauncherItemSharedProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  label?: string;
  tone?: "blue" | "green" | "orange" | "purple" | "slate";
}

export function LauncherItemShared({
  className,
  icon = <IconWorld />,
  label = "App",
  tone = "blue",
  ...props
}: LauncherItemSharedProps) {
  return (
    <button
      className={cn(
        "flex w-[116px] cursor-pointer flex-col items-center gap-2 border-0 bg-transparent p-0 font-sans outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]",
        className,
      )}
      data-pencil-component="Cllpy"
      type="button"
      {...props}
    >
      <IconTileApp className="size-14 rounded-[14px] [&_svg]:size-6" icon={icon} tone={tone} />
      <span className="w-full text-center text-[length:var(--app-font-size-ui,12px)] font-medium text-[var(--color-text-foreground-secondary)]">
        {label}
      </span>
    </button>
  );
}
