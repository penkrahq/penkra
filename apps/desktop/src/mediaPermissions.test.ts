// FILE: mediaPermissions.test.ts
// Purpose: Verifies the desktop microphone permission guard stays tolerant of optional Electron fields.
// Layer: Desktop unit test
// Depends on: mediaPermissions helper.

import { describe, expect, it, vi } from "vitest";

import {
  isTrustedMediaPermissionRequest,
  resolveMicrophonePermissionRequest,
  shouldAllowMediaPermissionRequest,
} from "./mediaPermissions";

const requester = (destroyed = false) => ({ isDestroyed: () => destroyed });

describe("shouldAllowMediaPermissionRequest", () => {
  it("allows requests when Electron omits mediaTypes", () => {
    expect(shouldAllowMediaPermissionRequest({})).toBe(true);
  });

  it("allows requests when Electron reports audio capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["audio"] })).toBe(true);
  });

  it("rejects requests that only ask for video capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["video"] })).toBe(false);
  });

  it("rejects mixed audio and video capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["audio", "video"] })).toBe(false);
  });

  it("handles Electron permission checks that report one mediaType", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaType: "audio" })).toBe(true);
    expect(shouldAllowMediaPermissionRequest({ mediaType: "video" })).toBe(false);
  });
});

describe("isTrustedMediaPermissionRequest", () => {
  it("allows audio only from the exact trusted live renderer", () => {
    const trusted = requester();
    expect(isTrustedMediaPermissionRequest(trusted, trusted, { mediaTypes: ["audio"] })).toBe(true);
    expect(isTrustedMediaPermissionRequest(requester(), trusted, { mediaTypes: ["audio"] })).toBe(
      false,
    );
    expect(isTrustedMediaPermissionRequest(trusted, null, { mediaTypes: ["audio"] })).toBe(false);
  });

  it("rejects destroyed renderers, subframes, and mismatched origins", () => {
    const destroyed = requester(true);
    expect(isTrustedMediaPermissionRequest(destroyed, destroyed, {})).toBe(false);

    const trusted = {
      isDestroyed: () => false,
      getURL: () => "penkra://app/index.html",
    };
    expect(
      isTrustedMediaPermissionRequest(trusted, trusted, {
        mediaType: "audio",
        isMainFrame: true,
        requestingUrl: "penkra://app/chat",
      }),
    ).toBe(true);
    expect(
      isTrustedMediaPermissionRequest(trusted, trusted, {
        mediaType: "audio",
        isMainFrame: false,
      }),
    ).toBe(false);
    expect(
      isTrustedMediaPermissionRequest(
        trusted,
        trusted,
        { mediaType: "audio", isMainFrame: true },
        "https://untrusted.example",
      ),
    ).toBe(false);
  });
});

describe("resolveMicrophonePermissionRequest", () => {
  it("accepts an existing grant without prompting", async () => {
    const askForAccess = vi.fn(async () => true);
    await expect(
      resolveMicrophonePermissionRequest({ status: "granted", askForAccess }),
    ).resolves.toBe(true);
    expect(askForAccess).not.toHaveBeenCalled();
  });

  it("prompts exactly once when macOS has not decided", async () => {
    const askForAccess = vi.fn(async () => true);
    await expect(
      resolveMicrophonePermissionRequest({ status: "not-determined", askForAccess }),
    ).resolves.toBe(true);
    expect(askForAccess).toHaveBeenCalledOnce();
  });

  it.each(["denied", "restricted", "unknown"] as const)(
    "rejects %s without repeatedly prompting",
    async (status) => {
      const askForAccess = vi.fn(async () => true);
      await expect(resolveMicrophonePermissionRequest({ status, askForAccess })).resolves.toBe(
        false,
      );
      expect(askForAccess).not.toHaveBeenCalled();
    },
  );

  it("turns prompt failures into a denial", async () => {
    await expect(
      resolveMicrophonePermissionRequest({
        status: "not-determined",
        askForAccess: async () => {
          throw new Error("TCC unavailable");
        },
      }),
    ).resolves.toBe(false);
  });
});
