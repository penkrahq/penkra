import { IconBrandFigma } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { cn } from "~/lib/utils";

import { BadgeRating } from "../badge-rating/BadgeRating";
import { ButtonInstall } from "../button-install/ButtonInstall";
import { IconTileApp } from "../icon-tile-app/IconTileApp";
import { PermissionRowShared } from "../permission-row-shared/PermissionRowShared";

export interface ModalAppDetailProps {
  category?: string;
  className?: string;
  description?: string;
  icon?: ReactNode;
  name?: string;
  onBack?: () => void;
  onInstall?: () => void;
  publisher?: string;
  rating?: string;
}

export function ModalAppDetail({
  category = "Design",
  className,
  description = "Bring your team's Figma files into a thread. Search projects, preview frames, and attach designs for review without switching context.",
  icon = <IconBrandFigma />,
  name = "Figma",
  onBack,
  onInstall,
  publisher = "by Penkra",
  rating = "4.9",
}: ModalAppDetailProps) {
  return (
    <section
      aria-label={`${name} details`}
      className={cn(
        "flex w-[560px] max-w-full flex-col gap-5 border border-[var(--color-border)] bg-[var(--color-background-surface)] p-7 font-sans",
        className,
      )}
      data-pencil-component="tmIN8"
    >
      <ButtonBack onClick={onBack} />
      <header className="flex items-center gap-4">
        <IconTileApp
          className="size-[72px] rounded-[18px] bg-[#a259ff] [&_svg]:size-8"
          icon={icon}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[22px] font-bold text-[var(--color-text-foreground)]">
            {name}
          </h2>
          <p className="text-xs text-[var(--color-text-foreground-tertiary)]">{publisher}</p>
          <div className="mt-1 flex items-center gap-2">
            <BadgeRating value={rating} />
            <span className="text-[11px] text-[var(--color-text-foreground-tertiary)]">·</span>
            <span className="text-[11px] text-[var(--color-text-foreground-tertiary)]">
              {category}
            </span>
          </div>
        </div>
        <ButtonInstall onClick={onInstall} />
      </header>
      <p className="text-[13px] leading-[1.5] text-[var(--color-text-foreground-secondary)]">
        {description}
      </p>
      <section className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold text-[var(--color-text-foreground-secondary)]">
          Permissions
        </h3>
        <PermissionRowShared
          reason='"Read your files and comments to show them in threads."'
          required
          title={`Access your ${name} account`}
        />
        <PermissionRowShared
          reason='"Attach the current thread when you share a file."'
          title="Read the conversation you're in"
        />
      </section>
    </section>
  );
}
