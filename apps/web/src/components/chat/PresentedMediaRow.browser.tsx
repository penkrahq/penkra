import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PresentedMediaRow } from "./PresentedMediaRow";

describe("presented image gallery", () => {
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
