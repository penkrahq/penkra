// FILE: ThreadErrorBanner.tsx
// Purpose: Shows dismissible thread-level runtime errors above the transcript.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export function ThreadErrorBanner({
  error,
  onDismiss,
  onRetry,
  onReauthenticate,
}: {
  error: string | null;
  onDismiss?: () => void;
  onRetry?: () => void;
  onReauthenticate?: () => void;
}) {
  if (!error) return null;
  const authFailure =
    error.startsWith("The provider is rejecting this Connection.") ||
    error.startsWith("This Connection needs sign-in again.");
  const detailSeparator = "\nProvider detail: ";
  const detailStart = authFailure ? error.indexOf(detailSeparator) : -1;
  const summary = detailStart >= 0 ? error.slice(0, detailStart) : error;
  const detail = detailStart >= 0 ? error.slice(detailStart + detailSeparator.length) : null;
  return (
    <ChatColumnBannerFrame>
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className={authFailure ? "" : "line-clamp-3"} title={summary}>
          {summary}
          {authFailure && detail ? (
            <details className="mt-1 text-xs opacity-80">
              <summary>Provider detail</summary>
              <div className="break-all">{detail}</div>
            </details>
          ) : null}
        </AlertDescription>
        {authFailure ? (
          <AlertAction className="flex items-center gap-2">
            {onRetry ? (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            ) : null}
            {onReauthenticate ? (
              <button type="button" onClick={onReauthenticate}>
                Re-authenticate
              </button>
            ) : null}
          </AlertAction>
        ) : onDismiss ? (
          <AlertAction className="items-center">
            <IconButton
              label="Dismiss error"
              className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          </AlertAction>
        ) : null}
      </Alert>
    </ChatColumnBannerFrame>
  );
}
