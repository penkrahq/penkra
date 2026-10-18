// FILE: ThreadDetailHydrationState.tsx
// Purpose: Render the transcript placeholder while thread history syncs (or after it fails).
// Layer: Chat presentation
// Depends on: shared Spinner and Button primitives.

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

export const ThreadDetailHydrationState = function ThreadDetailHydrationState({
  state,
  onRetry,
  error,
}: {
  state: "loading" | "failed" | "missing";
  onRetry: () => void;
  error?: unknown;
}) {
  if (state === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 select-none">
        <Spinner aria-label="Loading conversation" className="size-5 text-muted-foreground/50" />
        <span className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-muted-foreground/50">
          Loading conversation
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <span className="text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-muted-foreground">
        {state === "missing"
          ? "This conversation no longer exists."
          : "This conversation didn't load."}
      </span>
      {state === "failed" && error != null && (
        <span className="max-w-lg break-words text-sm text-muted-foreground">
          {error instanceof Error ? error.message : String(error)}
        </span>
      )}
      {state !== "missing" && (
        <Button onClick={onRetry} size="sm" variant="outline">
          Try again
        </Button>
      )}
    </div>
  );
};
