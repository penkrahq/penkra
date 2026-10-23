import { useEffect, useRef, useState } from "react";

import { type WorkLogPresentedMedia } from "../../session-logic";
import { ChevronLeftIcon, ChevronRightIcon, PlayIcon } from "~/lib/icons";
import { toAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { presentedVideoMimeType } from "./presentedMediaType";
import { openThreadAttachmentReference, useThreadResourceOpener } from "~/lib/threadResourceOpener";

function mediaUrl(attachmentId: string): string {
  return toAttachmentPreviewUrl(`/attachments/${encodeURIComponent(attachmentId)}`);
}

function isVisualMedia(item: WorkLogPresentedMedia): boolean {
  return item.type === "image" || presentedVideoMimeType(item) !== null;
}

function PresentedVideo({ item }: { item: WorkLogPresentedMedia }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  useEffect(() => {
    const video = ref.current;
    return () => {
      video?.pause();
    };
  }, []);
  return (
    <>
      <video
        ref={ref}
        src={mediaUrl(item.attachmentId)}
        controls
        playsInline
        preload="metadata"
        className="block max-h-[28rem] max-w-full"
        aria-label={item.name}
        onError={() => setPlaybackFailed(true)}
      />
      {playbackFailed ? (
        <p role="alert" className="mt-1 text-xs text-muted-foreground">
          This video could not be played. Use Open to view it with your configured app.
        </p>
      ) : null}
    </>
  );
}

function PresentedItem({
  item,
  onImageExpand,
}: {
  item: WorkLogPresentedMedia;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const opener = useThreadResourceOpener();
  const url = mediaUrl(item.attachmentId);
  const videoMimeType = presentedVideoMimeType(item);
  if (videoMimeType) {
    return (
      <figure className="my-2 max-w-full" data-presented-media-id={item.attachmentId}>
        <div className="w-fit max-w-full overflow-hidden rounded-xl border border-border">
          <PresentedVideo item={item} />
        </div>
        <figcaption className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{item.name}</span>
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() => void openThreadAttachmentReference(opener, item.attachmentId)}
          >
            Open
          </button>
        </figcaption>
      </figure>
    );
  }
  if (item.type === "file") {
    return (
      <button
        type="button"
        onClick={() => void openThreadAttachmentReference(opener, item.attachmentId)}
        className="my-2 inline-flex max-w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-accent"
        data-presented-media-id={item.attachmentId}
      >
        <span className="truncate">{item.name}</span>
        <span className="text-muted-foreground">Open</span>
      </button>
    );
  }
  return (
    <figure className="my-2 max-w-full" data-presented-media-id={item.attachmentId}>
      <button
        type="button"
        className="block max-w-full overflow-hidden rounded-xl border border-border"
        onClick={() => onImageExpand({ images: [{ src: url, name: item.name }], index: 0 })}
        aria-label={`Expand ${item.name}`}
      >
        <img src={url} alt={item.name} className="block max-h-[28rem] max-w-full object-contain" />
      </button>
      <figcaption className="mt-1 text-xs text-muted-foreground">{item.name}</figcaption>
    </figure>
  );
}

function PresentedMediaGallery({
  items,
  onImageExpand,
}: {
  items: ReadonlyArray<WorkLogPresentedMedia>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const opener = useThreadResourceOpener();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const index = Math.min(selectedIndex, items.length - 1);
  const selected = items[index]!;
  const imageItems = items.filter((item) => item.type === "image");
  const images = imageItems.map((item) => ({
    src: mediaUrl(item.attachmentId),
    name: item.name,
  }));
  const selectedIsVideo = presentedVideoMimeType(selected) !== null;
  const navigationKind = imageItems.length === items.length ? "image" : "media";
  const arrowClassName =
    "absolute top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/85 opacity-0 shadow-sm transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-background focus-visible:pointer-events-auto focus-visible:opacity-100 motion-reduce:transition-none";

  return (
    <figure
      className="my-2 w-[calc(100%-3rem)] max-w-xl"
      data-presented-gallery-id={items[0]!.presentationId ?? items[0]!.attachmentId}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-2">
        <div className="group relative min-w-0 overflow-hidden rounded-xl border border-border bg-muted/20">
          {selectedIsVideo ? (
            <div
              className="flex min-w-0 flex-col items-center"
              data-presented-media-id={selected.attachmentId}
            >
              <PresentedVideo key={selected.attachmentId} item={selected} />
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full items-center justify-center"
              onClick={() =>
                onImageExpand({
                  images,
                  index: imageItems.findIndex(
                    (item) => item.attachmentId === selected.attachmentId,
                  ),
                })
              }
              aria-label={`Expand ${selected.name}`}
              data-presented-media-id={selected.attachmentId}
            >
              <img
                src={mediaUrl(selected.attachmentId)}
                alt={selected.name}
                className="block max-h-[28rem] max-w-full object-contain"
              />
            </button>
          )}
          <button
            type="button"
            className={`${arrowClassName} left-2`}
            onClick={() => setSelectedIndex((index - 1 + items.length) % items.length)}
            aria-label={`Previous ${navigationKind}`}
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <button
            type="button"
            className={`${arrowClassName} right-2`}
            onClick={() => setSelectedIndex((index + 1) % items.length)}
            aria-label={`Next ${navigationKind}`}
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
        <div
          className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto"
          aria-label={navigationKind === "image" ? "Images" : "Media"}
        >
          {items.map((item, itemIndex) => (
            <button
              key={item.attachmentId}
              type="button"
              className={`relative aspect-square w-14 shrink-0 overflow-hidden rounded-lg border bg-muted/20 ${
                itemIndex === index ? "border-primary ring-1 ring-primary" : "border-border"
              }`}
              onClick={() => setSelectedIndex(itemIndex)}
              aria-label={`Show ${presentedVideoMimeType(item) ? "video" : "image"} ${itemIndex + 1}: ${item.name}`}
              aria-pressed={itemIndex === index}
            >
              {presentedVideoMimeType(item) ? (
                <>
                  <video
                    src={mediaUrl(item.attachmentId)}
                    muted
                    playsInline
                    preload="metadata"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="pointer-events-none size-full object-cover"
                  />
                  <PlayIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-1 right-1 size-3 rounded-sm bg-black/60 text-white"
                  />
                </>
              ) : (
                <img src={mediaUrl(item.attachmentId)} alt="" className="size-full object-cover" />
              )}
            </button>
          ))}
        </div>
      </div>
      <figcaption className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{selected.name}</span>
          {selectedIsVideo ? (
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => void openThreadAttachmentReference(opener, selected.attachmentId)}
            >
              Open
            </button>
          ) : null}
        </span>
        <span className="shrink-0">{`${index + 1} / ${items.length}`}</span>
      </figcaption>
    </figure>
  );
}

export function PresentedMediaRow({
  items,
  onImageExpand,
}: {
  items: ReadonlyArray<WorkLogPresentedMedia>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const visualItems = items.filter(isVisualMedia);
  return (
    <div>
      {items.map((item) =>
        visualItems.length > 1 && isVisualMedia(item) ? (
          item === visualItems[0] ? (
            <PresentedMediaGallery
              key={item.attachmentId}
              items={visualItems}
              onImageExpand={onImageExpand}
            />
          ) : null
        ) : (
          <PresentedItem key={item.attachmentId} item={item} onImageExpand={onImageExpand} />
        ),
      )}
    </div>
  );
}
