// @vitest-environment happy-dom
import { MessageId } from "@penkra/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";
import { useAttachmentPreviewHandoffs } from "./useAttachmentPreviewHandoffs";

const messageId = MessageId.makeUnsafe("preview-message");
function message(previewUrl: string): ChatMessage {
  return {
    id: messageId,
    role: "user",
    text: "Image sent",
    createdAt: "2026-10-11T00:00:00Z",
    streaming: false,
    attachments: [
      {
        type: "image",
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl,
      },
    ],
  };
}
function Transcript({
  threadId,
  serverMessages,
  renderedMessages,
  urls,
}: {
  threadId: string;
  serverMessages: ChatMessage[];
  renderedMessages: ChatMessage[];
  urls: string[];
}) {
  const handoff = useAttachmentPreviewHandoffs({ threadId, serverMessages, renderedMessages });
  useEffect(() => {
    handoff(messageId, urls);
  }, [handoff, urls]);
  return renderedMessages.map((row) => (
    <img
      key={row.id}
      alt="Sent image"
      src={row.attachments?.[0]?.type === "image" ? row.attachments[0].previewUrl : undefined}
    />
  ));
}
let root: Root;
let revoke: ReturnType<typeof vi.fn>;
let descriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  descriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  revoke = vi.fn((url: string) => {
    for (const image of document.querySelectorAll("img"))
      expect(image.getAttribute("src")).not.toBe(url);
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  if (descriptor) Object.defineProperty(URL, "revokeObjectURL", descriptor);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});
function render(
  threadId: string,
  serverMessages: ChatMessage[],
  renderedMessages: ChatMessage[],
  urls: string[],
) {
  act(() =>
    root.render(
      <Transcript
        threadId={threadId}
        serverMessages={serverMessages}
        renderedMessages={renderedMessages}
        urls={urls}
      />,
    ),
  );
}
it("keeps the sent blob until both persistence and the persisted image row commit", () => {
  const urls = ["blob:sent-image"];
  render("one", [], [message(urls[0]!)], urls);
  expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:sent-image");
  expect(revoke).not.toHaveBeenCalled();
  const persisted = message("/attachments/image");
  render("one", [persisted], [message(urls[0]!)], urls);
  expect(revoke).not.toHaveBeenCalled();
  render("one", [persisted], [persisted], urls);
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:sent-image");
});
it("accepts absolute persisted attachment URLs", () => {
  const urls = ["blob:absolute-image"];
  render("one", [], [message(urls[0]!)], urls);
  const persisted = message("https://penkra.test/attachments/image?token=credential");
  render("one", [persisted], [persisted], urls);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(urls[0]);
});
it("releases remaining handoffs when the thread changes", () => {
  const urls = ["blob:old-thread"];
  render("one", [], [message(urls[0]!)], urls);
  render("two", [], [], []);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(urls[0]);
});
it("releases remaining handoffs after the image unmounts", () => {
  const urls = ["blob:unmount"];
  render("one", [], [message(urls[0]!)], urls);
  act(() => root.unmount());
  expect(revoke).toHaveBeenCalledExactlyOnceWith(urls[0]);
});
