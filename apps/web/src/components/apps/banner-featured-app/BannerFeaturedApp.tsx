import { IconListCheck } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { ButtonInstall } from "../button-install/ButtonInstall";
import { IconTileApp } from "../icon-tile-app/IconTileApp";

export interface BannerFeaturedAppProps extends HTMLAttributes<HTMLElement> {
  icon?: ReactNode;
  name?: string;
  onInstall?: () => void;
  tagline?: string;
}

export function BannerFeaturedApp({
  className,
  icon = <IconListCheck />,
  name = "Linear",
  onInstall,
  tagline = "Track and plan engineering work without leaving a thread.",
  ...props
}: BannerFeaturedAppProps) {
  return (
    <article
      className={cn(
        "flex min-h-[104px] w-full items-center justify-between gap-5 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-5 font-sans",
        className,
      )}
      data-pencil-component="NCeS7"
      {...props}
    >
      <div className="flex min-w-0 items-center gap-4">
        <IconTileApp className="size-16 rounded-2xl bg-[#5e6ad2] [&_svg]:size-7" icon={icon} />
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-[0.6px] text-[var(--color-text-accent)]">
            FEATURED
          </p>
          <h3 className="truncate text-xl font-bold text-[var(--color-text-foreground)]">{name}</h3>
          <p className="truncate text-[13px] text-[var(--color-text-foreground-secondary)]">
            {tagline}
          </p>
        </div>
      </div>
      <ButtonInstall onClick={onInstall} />
    </article>
  );
}
