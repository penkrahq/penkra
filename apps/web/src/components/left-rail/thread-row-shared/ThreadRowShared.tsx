import type { ProviderKind } from "@synara/contracts";
import type { ComponentProps } from "react";
import { FaGithub } from "react-icons/fa6";

import { ProviderIcon } from "~/components/ProviderIcon";
import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export type ThreadRowLevel = "root" | "nested";
export type ThreadWorkStatus = "idle" | "running" | "done" | "attention";

export interface ThreadRowSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  harness?: ProviderKind | "github";
  level?: ThreadRowLevel;
  workStatus?: ThreadWorkStatus;
}

export function ThreadRowShared({
  children = "Main",
  className,
  harness = "claudeAgent",
  level = "root",
  workStatus = "idle",
  ...props
}: ThreadRowSharedProps) {
  const trailing =
    workStatus === "running" ? (
      <LoaderCircleIcon aria-label="Working" className="size-[13px] animate-spin" />
    ) : workStatus === "done" ? (
      <CircleCheckIcon aria-label="Done" className="size-[13px]" />
    ) : workStatus === "attention" ? (
      <CircleAlertIcon aria-label="Needs attention" className="size-[13px]" />
    ) : null;

  return (
    <LeftRailRow
      className={cn(
        "relative gap-3 pr-2.5",
        level === "nested" ? "pl-6" : "pl-2.5",
        workStatus === "running" &&
          "[&_[data-slot=thread-status]]:text-[var(--color-text-foreground-secondary)]",
        workStatus === "done" && "[&_[data-slot=thread-status]]:text-[var(--color-text-accent)]",
        workStatus === "attention" && "[&_[data-slot=thread-status]]:text-orange-500",
        className,
      )}
      leading={
        harness === "github" ? (
          <FaGithub aria-hidden className="size-3.5" />
        ) : (
          <ProviderIcon className="size-3.5" provider={harness} />
        )
      }
      leadingClassName="size-3.5"
      data-thread-level={level}
      data-work-status={workStatus}
      trailing={
        trailing ? (
          <span
            className="inline-flex size-6 shrink-0 items-center justify-end bg-sidebar group-hover/left-rail-row:bg-[var(--sidebar-accent)]"
            data-slot="thread-status"
          >
            {trailing}
          </span>
        ) : null
      }
      trailingClassName="absolute top-1/2 right-2.5 -translate-y-1/2"
      {...props}
    >
      {children}
    </LeftRailRow>
  );
}
