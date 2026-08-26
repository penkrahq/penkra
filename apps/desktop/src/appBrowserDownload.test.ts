// FILE: appBrowserDownload.test.ts
// Purpose: Locks the flat App-owned hosted Browser download contract.

import { describe, expect, it, vi } from "vitest";

import { prepareAppBrowserDownload } from "./appBrowserDownload";

describe("prepareAppBrowserDownload", () => {
  it("uses one flat downloads directory and exposes absolute and storage-relative paths", () => {
    const prepareDownloadSync = vi.fn(() => "/private/app-root/downloads/report-1.pdf");

    const result = prepareAppBrowserDownload(
      { prepareDownloadSync },
      { appId: "com.example.app", spaceId: "space-1" },
      "report.pdf",
    );

    expect(prepareDownloadSync).toHaveBeenCalledWith(
      { appId: "com.example.app", spaceId: "space-1" },
      { directory: "downloads", suggestedName: "report.pdf" },
    );
    expect(result).toEqual({
      path: "/private/app-root/downloads/report-1.pdf",
      storagePath: "downloads/report-1.pdf",
    });
  });
});
