import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: {},
  nativeTheme: { shouldUseDarkColors: true },
}));

import { androidSdkLicenseReviewDataUrl } from "./simulatorLicenseReview";

describe("androidSdkLicenseReviewDataUrl", () => {
  it("renders complete official text as inert content in trusted chrome", () => {
    const dataUrl = androidSdkLicenseReviewDataUrl({
      text: 'Terms <script>alert("no")</script> & conditions',
      ordinal: 2,
    });
    const html = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1));

    expect(html).toContain("Android SDK license 2");
    expect(html).toContain(
      "Terms &lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt; &amp; conditions",
    );
    expect(html).not.toContain('<script>alert("no")</script>');
    expect(html).toContain("Accept and continue");
    expect(html).toContain("Cancel setup");
  });
});
