// FILE: webviewWindowOpenPolicy.test.ts
// Purpose: Guards the fail-closed policy for webviews awaiting scoped Browser ownership.

import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { applyUnmanagedWebviewWindowOpenPolicy } from "./webviewWindowOpenPolicy";

function contentsOfType(type: ReturnType<WebContents["getType"]>) {
  return {
    getType: vi.fn(() => type),
    setWindowOpenHandler: vi.fn(),
  } as unknown as WebContents;
}

describe("applyUnmanagedWebviewWindowOpenPolicy", () => {
  it("denies windows from a new webview before its scoped owner attaches", () => {
    const contents = contentsOfType("webview");

    expect(applyUnmanagedWebviewWindowOpenPolicy(contents)).toBe(true);
    expect(contents.setWindowOpenHandler).toHaveBeenCalledOnce();

    const handler = vi.mocked(contents.setWindowOpenHandler).mock.calls[0]?.[0];
    expect(handler?.({} as Electron.HandlerDetails)).toEqual({ action: "deny" });
  });

  it("leaves non-webview contents unchanged", () => {
    const contents = contentsOfType("window");

    expect(applyUnmanagedWebviewWindowOpenPolicy(contents)).toBe(false);
    expect(contents.setWindowOpenHandler).not.toHaveBeenCalled();
  });
});
