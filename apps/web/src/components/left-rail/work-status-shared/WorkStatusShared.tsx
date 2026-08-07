import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, MicIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type WorkStatus = "idle" | "running" | "done" | "attention" | "recording";

export interface WorkStatusSharedProps {
  className?: string;
  status?: WorkStatus;
}

export function WorkStatusShared({ className, status = "idle" }: WorkStatusSharedProps) {
  if (status === "idle") return null;

  return (
    <span
      className={cn(
        "inline-flex h-[17px] w-[13px] shrink-0 items-center justify-center",
        status === "running" && "text-[var(--color-text-foreground-secondary)]",
        status === "done" && "text-[var(--color-text-accent)]",
        status === "attention" && "text-orange-500",
        status === "recording" && "text-destructive",
        className,
      )}
      data-pencil-component="AML75"
      data-slot="work-status"
      data-work-status={status}
    >
      {status === "running" ? (
        <LoaderCircleIcon aria-label="Working" className="size-[13px] animate-spin" />
      ) : status === "done" ? (
        <CircleCheckIcon aria-label="Done" className="size-[13px]" />
      ) : status === "recording" ? (
        <MicIcon
          aria-label="Recording voice"
          className="size-[13px] animate-pulse motion-reduce:animate-none"
        />
      ) : (
        <CircleAlertIcon aria-label="Needs attention" className="size-[13px]" />
      )}
    </span>
  );
}
