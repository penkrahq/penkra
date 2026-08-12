import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

describe("TimelineWorkEntryRow selection events", () => {
  it("shows the designed consequence tooltip for a Connection change", async () => {
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={{
          id: "connection-change",
          createdAt: "2026-08-09T00:00:00.000Z",
          label: "Connection changed to Work",
          tone: "info",
          activityKind: "connection-changed",
        }}
        chatMetaFontSizePx={12}
        markdownCwd={undefined}
        onImageExpand={vi.fn()}
      />,
    );

    try {
      await page.getByText("Connection changed to Work", { exact: true }).hover();
      await expect
        .element(page.getByText("New messages use this selection. Earlier messages are unchanged."))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
