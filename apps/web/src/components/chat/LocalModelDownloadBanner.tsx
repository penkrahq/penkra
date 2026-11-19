// FILE: LocalModelDownloadBanner.tsx
// Purpose: While the selected Local model isn't on this Mac yet, downloads it and
// shows progress above the transcript. Messages sent meanwhile wait for it on the
// server, so there is nothing for the user to do but watch or cancel.
// Layer: Chat status presentation

import { useEffect, useRef } from "react";

import { formatLocalModelSize, useLocalModels } from "~/hooks/useLocalModels";
import { DownloadIcon } from "~/lib/icons";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export function LocalModelDownloadBanner({ modelSlug }: { modelSlug: string | null }) {
  const { bySlug, download, cancelDownload } = useLocalModels(modelSlug !== null);
  const model = modelSlug ? bySlug.get(modelSlug) : undefined;
  const autoStarted = useRef<string | null>(null);

  const needsDownload = !!model && !model.downloaded && model.unavailableReason === null;
  const state = model?.download;

  // Selecting a model (from the picker, a default, or a slash command) starts its
  // download once. A failed or cancelled download waits for Retry.
  useEffect(() => {
    if (!model || !needsDownload || state?.kind !== "idle") return;
    if (autoStarted.current === model.slug) return;
    autoStarted.current = model.slug;
    void download(model.slug).catch(() => undefined);
  }, [download, model, needsDownload, state?.kind]);

  if (!model || !needsDownload || !state) return null;

  const total = state.kind === "downloading" && state.totalBytes > 0 ? state.totalBytes : model.downloadGb * 1024 ** 3;
  const received = state.kind === "downloading" ? state.receivedBytes : 0;
  const fraction = Math.min(1, received / total);
  const gb = (bytes: number) => formatLocalModelSize(bytes / 1024 ** 3);

  return (
    <ChatColumnBannerFrame>
      <Alert variant={state.kind === "failed" ? "error" : "default"}>
        <DownloadIcon />
        <AlertDescription className="gap-1.5">
          {state.kind === "failed" ? (
            <span>
              Couldn't download {model.name}. {state.message}
            </span>
          ) : (
            <>
              <span>
                Downloading {model.name} to this Mac
                <span className="tabular-nums text-muted-foreground/70">
                  {" "}
                  · {received >= 0.05 * 1024 ** 3 ? `${gb(received)} of ${gb(total)}` : gb(total)}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="block h-1 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
              >
                <span
                  className="block h-full rounded-full bg-[color-mix(in_srgb,var(--foreground)_45%,transparent)] transition-[width] duration-300"
                  style={{ width: `${Math.max(2, Math.round(fraction * 100))}%` }}
                />
              </span>
              <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
                One-time download. You can send a message now — it starts when the model is ready.
              </span>
            </>
          )}
        </AlertDescription>
        <AlertAction className="items-center">
          {state.kind === "failed" ? (
            <button type="button" onClick={() => void download(model.slug).catch(() => undefined)}>
              Retry
            </button>
          ) : (
            <button type="button" onClick={() => void cancelDownload(model.slug)}>
              Cancel
            </button>
          )}
        </AlertAction>
      </Alert>
    </ChatColumnBannerFrame>
  );
}
