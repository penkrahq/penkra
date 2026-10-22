// FILE: AllowIphoneDialog.tsx
// Purpose: "Allow iPhone?" — shown on the Mac when an iPhone asks to pair (TODO §7.2.6).
// The same 6-digit code is on the iPhone; matching codes prove the request is the operator's own.
// Layer: App-level presentation (planner-owned design; the caller supplies the request and answers).

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

export interface IphonePairingRequest {
  readonly requestId: string;
  /** The iPhone's device name, e.g. "Emmanuel's iPhone". */
  readonly phoneName: string;
  /** Six digits, derived from the pairing handshake on both devices. */
  readonly code: string;
}

export function AllowIphoneDialog(props: {
  /** The open request, or null. The server clears it on answer, on expiry (120 s) or on cancel from the iPhone. */
  readonly request: IphonePairingRequest | null;
  readonly onAnswer: (requestId: string, allow: boolean) => void;
}) {
  const request = props.request;
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        // Escape or clicking outside is "Don't Allow": nothing is granted by default.
        if (!open && request) props.onAnswer(request.requestId, false);
      }}
    >
      <AlertDialogPopup className="max-w-[400px]" bottomStickOnMobile={false}>
        {request ? (
          <>
            <AlertDialogHeader className="items-center pt-6 text-center sm:text-center">
              <AlertDialogTitle>Allow “{request.phoneName}”?</AlertDialogTitle>
              <AlertDialogDescription className="max-w-[320px]">
                It will be able to see and use the threads on this Mac from anywhere. Check that the
                code below matches the one on your iPhone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div
              className="flex justify-center gap-1.5 px-4 pt-2 pb-3"
              aria-label={`Code ${request.code.split("").join(" ")}`}
              role="img"
            >
              {request.code.split("").map((digit, index) => (
                <span
                  key={index}
                  className="flex h-12 w-10 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] font-mono text-[22px] font-semibold tabular-nums text-[var(--color-text-foreground)]"
                >
                  {digit}
                </span>
              ))}
            </div>
            <AlertDialogFooter className="sm:justify-center">
              <Button variant="outline" onClick={() => props.onAnswer(request.requestId, false)}>
                Don’t Allow
              </Button>
              <Button onClick={() => props.onAnswer(request.requestId, true)}>Allow</Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
