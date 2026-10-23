import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PresentedMediaRow } from "./PresentedMediaRow";

const { mediaUrls } = vi.hoisted(() => ({ mediaUrls: new Map<string, string>() }));
vi.mock("~/lib/wsHttpUrl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/wsHttpUrl")>();
  return {
    ...actual,
    toAttachmentPreviewUrl: (url: string) =>
      mediaUrls.get(url) ?? actual.toAttachmentPreviewUrl(url),
  };
});

afterEach(() => {
  for (const url of mediaUrls.values()) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  mediaUrls.clear();
});

async function videoFixture(id: string, extension: string) {
  const fixtureUrl =
    extension === "mp4"
      ? new URL(
          "../../../../../docs/qa/attachment-media-20261022/player-fixture.mp4",
          import.meta.url,
        ).href
      : new URL(
          "../../../../../docs/qa/tab-activation-hang/additions/matrix/qa-record.webm",
          import.meta.url,
        ).href;
  // Codec/controls tests use a completely available fixture; HTTP streaming and
  // byte-range semantics are independently exercised by localImageRoute.test.
  const blobUrl = URL.createObjectURL(await (await fetch(fixtureUrl)).blob());
  mediaUrls.set(`/attachments/${id}`, blobUrl);
}

describe("presented image gallery", () => {
  it.each(["webm", "mp4"])(
    "renders video controls and plays and seeks an actual %s",
    async (extension) => {
      await videoFixture("att_v2_clip", extension);
      const screen = await render(
        <PresentedMediaRow
          items={[
            {
              attachmentId: "att_v2_clip",
              name: `recording.${extension}`,
              mimeType: "application/octet-stream",
              sizeBytes: 100,
              type: "file",
            },
          ]}
          onImageExpand={vi.fn()}
        />,
      );
      try {
        const video = document.querySelector("video")!;
        expect(video).not.toBeNull();
        expect(video.controls).toBe(true);
        expect(video.autoplay).toBe(false);
        await expect.poll(() => video.readyState).toBeGreaterThanOrEqual(2);
        await page.getByLabelText(`recording.${extension}`).click();
        await video.play();
        await expect.poll(() => video.currentTime).toBeGreaterThan(0);
        video.pause();
        const target = Math.min(0.5, video.duration / 2);
        await expect
          .poll(() => video.seekable.length > 0 && video.seekable.end(0) >= target)
          .toBe(true);
        const seeked = new Promise<void>((resolve) =>
          video.addEventListener("seeked", () => resolve(), { once: true }),
        );
        video.currentTime = target;
        await seeked;
        expect(video.currentTime).toBeCloseTo(target, 1);
        expect(video.videoWidth).toBeGreaterThan(0);
        await page.screenshot({
          path: `../../../../../.penkra/scratch/attachment-media/video-player-${extension}.png`,
        });
      } finally {
        await screen.unmount();
      }
    },
  );
  it("uses the photo gallery for videos and mixed media and pauses the previous player", async () => {
    await videoFixture("one", "mp4");
    await videoFixture("two", "webm");
    mediaUrls.set(
      "/attachments/photo",
      "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#3478f6"/></svg>',
        ),
    );
    const onImageExpand = vi.fn();
    const screen = await render(
      <div style={{ width: 320 }}>
        <PresentedMediaRow
          items={[
            {
              attachmentId: "one",
              name: "one.mp4",
              mimeType: "video/mp4",
              type: "file",
              sizeBytes: 100,
              presentationId: "mixed",
            },
            {
              attachmentId: "two",
              name: "two.webm",
              mimeType: "video/webm",
              type: "file",
              sizeBytes: 100,
              presentationId: "mixed",
            },
            {
              attachmentId: "photo",
              name: "photo.png",
              mimeType: "image/png",
              type: "image",
              sizeBytes: 100,
              presentationId: "mixed",
            },
          ]}
          onImageExpand={onImageExpand}
        />
      </div>,
    );
    try {
      const first = document.querySelector<HTMLVideoElement>("video[controls]")!;
      await expect.poll(() => first.readyState).toBeGreaterThanOrEqual(2);
      await page.getByLabelText("one.mp4", { exact: true }).click();
      await first.play();
      await expect.poll(() => first.paused).toBe(false);
      const pause = vi.spyOn(first, "pause");
      await page.getByRole("button", { name: "Show video 2: two.webm" }).click();
      expect(pause).toHaveBeenCalled();
      expect(first.isConnected).toBe(false);
      expect(document.querySelectorAll("video[controls]")).toHaveLength(1);
      const second = document.querySelector<HTMLVideoElement>("video[controls]")!;
      expect(second.paused).toBe(true);
      await expect.element(page.getByText("2 / 3", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Show image 3: photo.png" }).click();
      expect(document.querySelectorAll("video[controls]")).toHaveLength(0);
      await page.getByRole("button", { name: "Expand photo.png" }).click();
      expect(onImageExpand).toHaveBeenCalledWith({
        images: [{ src: mediaUrls.get("/attachments/photo"), name: "photo.png" }],
        index: 0,
      });
      await page.getByRole("button", { name: "Previous media" }).click();
      await expect.element(page.getByText("2 / 3", { exact: true })).toBeVisible();
      await page.screenshot({
        element: screen.container,
        path: "../../../../../.penkra/scratch/attachment-media/mixed-gallery.png",
      });
    } finally {
      await screen.unmount();
    }
  });
  it("leaves a right gutter within a narrow assistant column", async () => {
    const screen = await render(
      <div style={{ width: 600 }} data-testid="assistant-column">
        <PresentedMediaRow
          items={[
            {
              attachmentId: "first",
              name: "First.png",
              mimeType: "image/png",
              sizeBytes: 100,
              type: "image",
              presentationId: "gallery",
              presentationIndex: 0,
            },
            {
              attachmentId: "second",
              name: "Second.png",
              mimeType: "image/png",
              sizeBytes: 100,
              type: "image",
              presentationId: "gallery",
              presentationIndex: 1,
            },
          ]}
          onImageExpand={vi.fn()}
        />
      </div>,
    );

    try {
      const column = document.querySelector<HTMLElement>('[data-testid="assistant-column"]')!;
      const gallery = document.querySelector<HTMLElement>("[data-presented-gallery-id]")!;
      expect(gallery.getBoundingClientRect().right).toBeLessThan(
        column.getBoundingClientRect().right,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps navigation arrows out of the image until hover", async () => {
    const screen = await render(
      <div>
        <button type="button">Outside gallery</button>
        <PresentedMediaRow
          items={[
            {
              attachmentId: "first",
              name: "First.png",
              mimeType: "image/png",
              sizeBytes: 100,
              type: "image",
              presentationId: "gallery",
              presentationIndex: 0,
            },
            {
              attachmentId: "second",
              name: "Second.png",
              mimeType: "image/png",
              sizeBytes: 100,
              type: "image",
              presentationId: "gallery",
              presentationIndex: 1,
            },
          ]}
          onImageExpand={vi.fn()}
        />
      </div>,
    );

    try {
      const previous = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Previous image"]',
      );
      expect(previous).not.toBeNull();
      await page.getByRole("button", { name: "Outside gallery" }).hover();
      await expect.poll(() => getComputedStyle(previous!).opacity).toBe("0");

      await page.getByRole("button", { name: "Expand First.png" }).hover();
      await expect.poll(() => getComputedStyle(previous!).opacity).toBe("1");
    } finally {
      await screen.unmount();
    }
  });
});
