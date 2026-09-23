import { useState } from "react";

import { type WorkLogPresentedMedia } from "../../session-logic";
import { ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { toAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

function mediaUrl(attachmentId: string): string {
  return toAttachmentPreviewUrl(`/attachments/${encodeURIComponent(attachmentId)}`);
}

function PresentedItem({
  item,
  onImageExpand,
}: {
  item: WorkLogPresentedMedia;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const url = mediaUrl(item.attachmentId);
  if (item.type === "file") {
    return (
      <a
        href={url}
        download={item.name}
        className="my-2 inline-flex max-w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-accent"
        data-presented-media-id={item.attachmentId}
      >
        <span className="truncate">{item.name}</span>
        <span className="text-muted-foreground">Download</span>
      </a>
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

function PresentedImageGallery({
  items,
  onImageExpand,
}: {
  items: ReadonlyArray<WorkLogPresentedMedia>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const index = Math.min(selectedIndex, items.length - 1);
  const selected = items[index]!;
  const images = items.map((item) => ({ src: mediaUrl(item.attachmentId), name: item.name }));
  const arrowClassName =
    "absolute top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/85 opacity-0 shadow-sm transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-background focus-visible:pointer-events-auto focus-visible:opacity-100 motion-reduce:transition-none";

  return (
    <figure className="my-2 w-full max-w-2xl" data-presented-gallery-id={selected.presentationId}>
      <div className="grid grid-cols-[minmax(0,1fr)_3.5rem] gap-2">
        <div className="group relative min-w-0 overflow-hidden rounded-xl border border-border bg-muted/20">
          <button
            type="button"
            className="flex w-full items-center justify-center"
            onClick={() => onImageExpand({ images, index })}
            aria-label={`Expand ${selected.name}`}
            data-presented-media-id={selected.attachmentId}
          >
            <img
              src={images[index]!.src}
              alt={selected.name}
              className="block max-h-[28rem] max-w-full object-contain"
            />
          </button>
          <button
            type="button"
            className={`${arrowClassName} left-2`}
            onClick={() => setSelectedIndex((index - 1 + items.length) % items.length)}
            aria-label="Previous image"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <button
            type="button"
            className={`${arrowClassName} right-2`}
            onClick={() => setSelectedIndex((index + 1) % items.length)}
            aria-label="Next image"
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
        <div className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto" aria-label="Images">
          {items.map((item, itemIndex) => (
            <button
              key={item.attachmentId}
              type="button"
              className={`aspect-square w-14 shrink-0 overflow-hidden rounded-lg border bg-muted/20 ${
                itemIndex === index ? "border-primary ring-1 ring-primary" : "border-border"
              }`}
              onClick={() => setSelectedIndex(itemIndex)}
              aria-label={`Show image ${itemIndex + 1}: ${item.name}`}
              aria-pressed={itemIndex === index}
            >
              <img src={images[itemIndex]!.src} alt="" className="size-full object-cover" />
            </button>
          ))}
        </div>
      </div>
      <figcaption className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{selected.name}</span>
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
  if (items.length > 1 && items.every((item) => item.type === "image")) {
    return <PresentedImageGallery items={items} onImageExpand={onImageExpand} />;
  }
  return (
    <div>
      {items.map((item) => (
        <PresentedItem key={item.attachmentId} item={item} onImageExpand={onImageExpand} />
      ))}
    </div>
  );
}
