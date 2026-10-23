import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PresentedMediaRow } from "./PresentedMediaRow";

describe("presented attachment rendering", () => {
  it.each(["video/mp4", "application/octet-stream"])(
    "plays current and historical MP4 metadata (%s)",
    (mimeType) => {
      const markup = renderToStaticMarkup(
        <PresentedMediaRow
          items={[
            {
              attachmentId: "att_v2_video",
              name: "download-progress.mp4",
              mimeType,
              sizeBytes: 100,
              type: "file",
            },
          ]}
          onImageExpand={() => {}}
        />,
      );
      expect(markup).toContain("<video");
      expect(markup).toContain('controls=""');
      expect(markup).toContain('preload="metadata"');
      expect(markup).not.toContain("autoplay");
      expect(markup).not.toContain("Download");
      expect(markup).toContain(">Open</button>");
    },
  );

  it("routes non-video files to Open rather than download", () => {
    const markup = renderToStaticMarkup(
      <PresentedMediaRow
        items={[
          {
            attachmentId: "att_v2_pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
            type: "file",
          },
        ]}
        onImageExpand={() => {}}
      />,
    );
    expect(markup).not.toContain("<video");
    expect(markup).not.toContain("download=");
    expect(markup).toContain(">Open</span>");
  });

  it("keeps image expansion unchanged", () => {
    const markup = renderToStaticMarkup(
      <PresentedMediaRow
        items={[
          {
            attachmentId: "att_v2_image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 100,
            type: "image",
          },
        ]}
        onImageExpand={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Expand image.png"');
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<video");
  });
});
