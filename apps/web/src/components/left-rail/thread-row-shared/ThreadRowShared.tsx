import type { ProviderKind } from "@penkra/contracts";
import type { ComponentProps } from "react";
import { FaGithub } from "react-icons/fa6";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";
import { LeftRailRow } from "../row-shared/LeftRailRow";
import { WorkStatusShared, type WorkStatus } from "../work-status-shared/WorkStatusShared";

export type ThreadRowLevel = "root" | "nested";
export type ThreadWorkStatus = WorkStatus;

export interface ThreadRowSharedProps extends Omit<
  ComponentProps<typeof LeftRailRow>,
  "leading" | "trailing"
> {
  harness?: ProviderKind | "github";
  level?: ThreadRowLevel;
  workStatus?: ThreadWorkStatus;
}
export function ThreadRowLeading(props: { harness?: ProviderKind | "github" }) {
  const harness = props.harness ?? "claudeAgent";
  return (
    <span className="relative inline-flex size-3.5 items-center justify-center">
      {harness === "github" ? (
        <FaGithub aria-hidden className="size-3.5" />
      ) : (
        <ProviderIcon className="size-3.5" provider={harness} />
      )}
    </span>
  );
}

export function ThreadRowShared({
  children = "Main",
  className,
  harness = "claudeAgent",
  level = "root",
  state = "default",
  workStatus = "idle",
  ...props
}: ThreadRowSharedProps) {
  const trailing = <WorkStatusShared status={workStatus} />;

  return (
    <LeftRailRow
      className={cn(
        "relative gap-3 pr-2.5",
        level === "nested" ? "pl-6" : "pl-2.5",
        state === "active" &&
          "bg-[var(--color-background-button-secondary-hover)] text-[var(--color-text-foreground)]",
        className,
      )}
      leading={<ThreadRowLeading harness={harness} />}
      leadingClassName="size-3.5"
      data-thread-level={level}
      data-work-status={workStatus}
      state={state}
      trailing={
        workStatus !== "idle" ? (
          <span
            className="inline-flex size-3.5 shrink-0 items-center justify-center"
            data-slot="thread-status"
          >
            {trailing}
          </span>
        ) : null
      }
      {...props}
    >
      {children}
    </LeftRailRow>
  );
}
