import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PresentedMediaRow } from "./PresentedMediaRow";

describe("presented image gallery", () => {
  it.each(["webm", "mp4"])(
    "renders video controls and plays and seeks an actual %s",
    async (extension) => {
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
        // Exercise Chromium decoding with the repository's existing tiny recording.
        // Production attachment transport/ranges are exercised by localImageRoute.test.
        video.src =
          extension === "mp4"
            ? new URL(
                "../../../../../docs/qa/attachment-media-20261022/player-fixture.mp4",
                import.meta.url,
              ).href
            : new URL(
                "../../../../../docs/qa/tab-activation-hang/additions/matrix/qa-record.webm",
                import.meta.url,
              ).href;
        await expect.poll(() => video.readyState).toBeGreaterThanOrEqual(2);
        await page.getByLabelText(`recording.${extension}`).click();
        await video.play();
        await expect.poll(() => video.currentTime).toBeGreaterThan(0);
        video.pause();
        const target = Math.min(0.5, video.duration / 2);
        video.currentTime = target;
        await expect.poll(() => video.seeking).toBe(false);
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
