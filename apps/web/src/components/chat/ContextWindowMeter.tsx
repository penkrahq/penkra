import {
  type ContextWindowSnapshot,
  deriveContextWindowMeterDisplay,
  formatContextWindowTokens,
  formatCostUsd,
} from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  cumulativeCostUsd?: number | null | undefined;
  activeWindowLabel?: string | null | undefined;
  pendingWindowLabel?: string | null | undefined;
  className?: string | undefined;
}) {
  const { usage, cumulativeCostUsd, activeWindowLabel, pendingWindowLabel, className } = props;
  const display = deriveContextWindowMeterDisplay(usage);
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (display.normalizedPercentage / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "group inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition-opacity hover:opacity-80",
              className,
            )}
            aria-label={display.ariaLabel}
          >
            <span className="relative flex size-[13px] items-center justify-center">
              <svg
                viewBox="0 0 16 16"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted-foreground/25 dark:text-muted-foreground/40"
                />
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="text-primary transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none dark:text-[var(--color-text-foreground)]"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-muted-foreground">
            Context window
          </div>
          {pendingWindowLabel ? (
            <div className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
              Current session: {activeWindowLabel ?? "Unknown"}
            </div>
          ) : null}
          {display.usedPercentageLabel ? (
            <div className="whitespace-nowrap text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
              <span>{display.usedPercentageLabel}</span>
              {display.hasReliableTokenRatio ? (
                <>
                  <span className="mx-1">⋅</span>
                  <span>{display.tokenUsageLabel}</span>
                  <span>/</span>
                  <span>{formatContextWindowTokens(usage.maxTokens)} context used</span>
                </>
              ) : (
                <span className="ml-1">context used</span>
              )}
            </div>
          ) : (
            <div className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-foreground">
              {display.tokenUsageLabel} tokens used so far
            </div>
          )}
          {usage.maxTokens !== null ? (
            <div className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
              Model window: {formatContextWindowTokens(usage.maxTokens)} tokens
            </div>
          ) : null}
          {pendingWindowLabel ? (
            <div className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
              Next turn: {pendingWindowLabel}
            </div>
          ) : null}
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
              Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              tokens
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
              Automatically compacts its context when needed.
            </div>
          ) : null}
          {cumulativeCostUsd !== null && cumulativeCostUsd !== undefined ? (
            <div className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
              Session cost: {formatCostUsd(cumulativeCostUsd)}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
