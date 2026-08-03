// FILE: SplashScreen.tsx
// Purpose: Render the branded startup face while the app is still booting a route or session.
// Layer: Shared app loading presentation

import { PenkraMark } from "~/components/foundations/penkra-mark-shared/PenkraMark";

export function SplashScreen({
  errorMessage,
  onRetry,
}: {
  errorMessage?: string | null;
  onRetry?: (() => void) | null;
}) {
  const showRetry = Boolean(errorMessage && onRetry);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5 select-none">
        <PenkraMark aria-label="Penkra" className="size-24" />

        {errorMessage ? (
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
            <span className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-muted-foreground/75">
              {errorMessage}
            </span>
            {showRetry ? (
              <button
                type="button"
                className="rounded-md border border-border/70 px-3 py-1.5 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-foreground/85 transition-colors hover:bg-[var(--sidebar-accent)]"
                onClick={onRetry ?? undefined}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
