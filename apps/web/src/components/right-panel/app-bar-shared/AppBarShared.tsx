import {
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconDownload,
  IconLock,
  IconRefresh,
  IconShare,
} from "@tabler/icons-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface AppBarSharedProps {
  address?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  className?: string;
  onBack?: () => void;
  onDownload?: () => void;
  onForward?: () => void;
  onMore?: () => void;
  onRefresh?: () => void;
  onShare?: () => void;
}

function AppBarButton({
  "aria-label": ariaLabel,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      aria-label={ariaLabel}
      className={cn(
        "inline-flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-[var(--color-text-foreground-secondary)] outline-none hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-default disabled:opacity-40 [&_svg]:size-3.5",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function AppBarShared({
  address = "penkra.app",
  canGoBack = true,
  canGoForward = true,
  className,
  onBack,
  onDownload,
  onForward,
  onMore,
  onRefresh,
  onShare,
}: AppBarSharedProps) {
  return (
    <div
      className={cn("flex h-8 w-[420px] flex-col bg-transparent font-sans", className)}
      data-pencil-component="HQgpR"
    >
      <div className="flex h-[31px] w-full items-center gap-2 px-2">
        <div className="flex items-center gap-0.5">
          <AppBarButton aria-label="Back" disabled={!canGoBack} onClick={onBack}>
            <IconChevronLeft />
          </AppBarButton>
          <AppBarButton aria-label="Forward" disabled={!canGoForward} onClick={onForward}>
            <IconChevronRight />
          </AppBarButton>
          <AppBarButton aria-label="Refresh" onClick={onRefresh}>
            <IconRefresh />
          </AppBarButton>
        </div>

        <div className="flex h-full min-w-0 flex-1 items-center justify-center">
          <div className="flex h-[22px] w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-control-opaque)] px-3 text-[11px] text-[var(--color-text-foreground-secondary)]">
            <IconLock aria-hidden="true" className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{address}</span>
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          <AppBarButton aria-label="Share" onClick={onShare}>
            <IconShare />
          </AppBarButton>
          <AppBarButton aria-label="Download" onClick={onDownload}>
            <IconDownload />
          </AppBarButton>
          <AppBarButton aria-label="More" onClick={onMore}>
            <IconDots />
          </AppBarButton>
        </div>
      </div>
      <div className="h-px w-full bg-[var(--color-border)]" />
    </div>
  );
}
