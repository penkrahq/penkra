// FILE: LocalModelRadioItem.tsx
// Purpose: One on-device model in the Local provider's picker: name, a one-line
// note or reason, and its download control. Models too big for this Mac stay
// listed, disabled, with the reason underneath.
// Layer: Chat composer presentation

import type { LocalModelListing } from "@penkra/contracts";

import { formatLocalModelSize } from "~/hooks/useLocalModels";
import { cn } from "~/lib/utils";
import { MenuRadioItem } from "../ui/menu";
import { COMPOSER_PICKER_RADIUS_CLASS_NAME } from "./composerPickerStyles";

const TRAILING_BUTTON_CLASS_NAME = cn(
  "inline-flex h-5 shrink-0 items-center justify-center px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
);

export function LocalModelRadioItem(
  props: Readonly<{
    model: LocalModelListing;
    onDownload: (slug: string) => void;
    onCancelDownload: (slug: string) => void;
    onWarm: (slug: string) => void;
    onAfterSelection?: () => void;
  }>,
) {
  const { model } = props;
  const disabled = model.unavailableReason !== null;
  const download = model.download;
  const percent =
    download.kind === "downloading" && download.totalBytes > 0
      ? Math.min(99, Math.floor((download.receivedBytes / download.totalBytes) * 100))
      : 0;
  const detail = disabled
    ? model.unavailableReason
    : download.kind === "failed"
      ? download.message
      : model.note;

  const stop = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const trailing = disabled ? null : download.kind === "downloading" ? (
    <button
      type="button"
      aria-label={`Cancel downloading ${model.name}`}
      title="Cancel download"
      className={TRAILING_BUTTON_CLASS_NAME}
      onPointerDown={stop}
      onClick={(event) => {
        stop(event);
        props.onCancelDownload(model.slug);
      }}
    >
      {percent}%
    </button>
  ) : !model.downloaded ? (
    <button
      type="button"
      aria-label={`Download ${model.name} (${formatLocalModelSize(model.downloadGb)})`}
      className={TRAILING_BUTTON_CLASS_NAME}
      onPointerDown={stop}
      onClick={(event) => {
        stop(event);
        props.onDownload(model.slug);
      }}
    >
      {download.kind === "failed" ? "Retry" : formatLocalModelSize(model.downloadGb)}
    </button>
  ) : null;

  return (
    <MenuRadioItem
      value={model.slug}
      disabled={disabled}
      preserveChildLayout
      className="grid-cols-[minmax(0,1fr)_auto] py-1"
      trailing={trailing}
      onClick={() => {
        // Picking a model that isn't on this Mac yet starts its download.
        if (!disabled && !model.downloaded && download.kind !== "downloading") {
          props.onDownload(model.slug);
        }
        // Load it now so the first message does not wait for the prompt read.
        if (!disabled && model.downloaded) props.onWarm(model.slug);
        props.onAfterSelection?.();
      }}
    >
      <span className="flex min-w-0 flex-col">
        <span className={cn("block min-w-0 truncate", disabled && "text-muted-foreground/60")}>
          {model.name}
        </span>
        {detail ? (
          <span
            className={cn(
              "block min-w-0 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60",
              download.kind === "failed" && !disabled && "text-destructive/80",
            )}
          >
            {detail}
          </span>
        ) : null}
        {download.kind === "downloading" ? (
          <span
            aria-hidden="true"
            className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
          >
            <span
              className="block h-full rounded-full bg-[color-mix(in_srgb,var(--foreground)_45%,transparent)] transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : null}
      </span>
    </MenuRadioItem>
  );
}
