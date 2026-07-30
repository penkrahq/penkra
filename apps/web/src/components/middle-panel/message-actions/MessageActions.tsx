import { IconCopy, IconPencil, IconRefresh } from "@tabler/icons-react";

import { IconActionTooltip } from "~/components/foundations/icon-action-tooltip/IconActionTooltip";
import { cn } from "~/lib/utils";

export interface MessageActionsProps {
  assistant?: boolean;
  className?: string;
  onCopy?: () => void;
  onEdit?: () => void;
  onRetry?: () => void;
  time?: string;
  visible?: boolean;
}

export function MessageActions({
  assistant = false,
  className,
  onCopy,
  onEdit,
  onRetry,
  time = "3:48 AM",
  visible = false,
}: MessageActionsProps) {
  const secondaryAction = assistant ? onRetry : onEdit;
  const actions = (
    <span
      className={cn(
        "flex h-[26px] items-center gap-1 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <IconActionTooltip
        ariaLabel={assistant ? "Copy response" : "Copy message"}
        label={assistant ? "Copy response" : "Copy message"}
        shortcut=""
        {...(onCopy === undefined ? {} : { onClick: onCopy })}
      >
        <IconCopy className="size-[13px]" />
      </IconActionTooltip>
      <IconActionTooltip
        ariaLabel={assistant ? "Retry response" : "Edit message"}
        label={assistant ? "Retry response" : "Edit message"}
        shortcut=""
        {...(secondaryAction === undefined ? {} : { onClick: secondaryAction })}
      >
        {assistant ? (
          <IconRefresh className="size-[13px]" />
        ) : (
          <IconPencil className="size-[13px]" />
        )}
      </IconActionTooltip>
    </span>
  );

  return (
    <div
      className={cn(
        "flex h-[26px] items-center text-[11px] text-[var(--color-text-foreground-tertiary)]",
        className,
      )}
    >
      {assistant ? actions : null}
      <time className="px-2">{time}</time>
      {assistant ? null : actions}
    </div>
  );
}
