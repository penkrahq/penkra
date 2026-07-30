import type { ProviderKind } from "@synara/contracts";
import { IconRefresh } from "@tabler/icons-react";
import type { ComponentProps } from "react";
import { FaGithub } from "react-icons/fa6";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface ThreadRowSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  harness?: ProviderKind | "github";
  refreshing?: boolean;
}

export function ThreadRowShared({
  children = "Main",
  className,
  harness = "claudeAgent",
  refreshing = false,
  ...props
}: ThreadRowSharedProps) {
  return (
    <LeftRailRow
      className={cn("pr-2.5 pl-6", className)}
      leading={
        harness === "github" ? (
          <FaGithub aria-hidden className="size-3.5" />
        ) : (
          <ProviderIcon className="size-3.5" provider={harness} />
        )
      }
      trailing={
        refreshing ? (
          <IconRefresh aria-label="Refreshing" className="size-[13px] animate-spin" />
        ) : null
      }
      {...props}
    >
      {children}
    </LeftRailRow>
  );
}
