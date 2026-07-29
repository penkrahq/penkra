import { IconBrandChrome } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { ButtonInstall } from "../button-install/ButtonInstall";
import { IconTileApp, type IconTileAppProps } from "../icon-tile-app/IconTileApp";

export interface RowInstalledAppProps extends HTMLAttributes<HTMLElement> {
  action?: ReactNode;
  description?: string;
  icon?: ReactNode;
  name?: string;
  onOpen?: () => void;
  tone?: IconTileAppProps["tone"];
}

export function RowInstalledApp({
  action,
  className,
  description = "Search the web and pull in pages without leaving your thread.",
  icon = <IconBrandChrome />,
  name = "Browser",
  onOpen,
  tone = "blue",
  ...props
}: RowInstalledAppProps) {
  return (
    <article
      className={cn(
        "flex min-h-16 w-full items-center gap-3 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-4 py-3 font-sans",
        className,
      )}
      data-pencil-component="aPvtw"
      {...props}
    >
      <IconTileApp className="size-10 [&_svg]:size-[18px]" icon={icon} tone={tone} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="truncate text-sm font-semibold text-[var(--color-text-foreground)]">
          {name}
        </strong>
        <span className="truncate text-xs text-[var(--color-text-foreground-tertiary)]">
          {description}
        </span>
      </span>
      {action ?? <ButtonInstall installed onClick={onOpen} />}
    </article>
  );
}
