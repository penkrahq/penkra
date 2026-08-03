import { IconPackage } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { BadgeRating } from "../badge-rating/BadgeRating";
import { ButtonInstall } from "../button-install/ButtonInstall";
import { IconTileApp, type IconTileAppProps } from "../icon-tile-app/IconTileApp";

export interface CardAppStoreProps extends HTMLAttributes<HTMLElement> {
  description?: string;
  icon?: ReactNode;
  installed?: boolean;
  name?: string;
  onInstall?: () => void;
  rating?: string;
  tone?: IconTileAppProps["tone"];
}

export function CardAppStore({
  className,
  description = "Description of what this app does for you.",
  icon = <IconPackage />,
  installed = false,
  name = "App",
  onInstall,
  rating = "4.9",
  tone,
  ...props
}: CardAppStoreProps) {
  return (
    <article
      className={cn(
        "flex min-h-[179px] w-[220px] flex-col gap-2.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4 font-sans",
        className,
      )}
      data-pencil-component="fgUwH"
      {...props}
    >
      <IconTileApp icon={icon} {...(tone === undefined ? {} : { tone })} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <strong className="truncate text-[length:calc(var(--app-font-size-base,12px)*1.1667)] font-semibold text-[var(--color-text-foreground)]">
            {name}
          </strong>
          <BadgeRating value={rating} />
        </div>
        <p className="line-clamp-2 text-[length:var(--app-font-size-ui,12px)] leading-[1.4] text-[var(--color-text-foreground-tertiary)]">
          {description}
        </p>
      </div>
      <ButtonInstall installed={installed} onClick={onInstall} />
    </article>
  );
}
