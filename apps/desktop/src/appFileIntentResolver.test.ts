import { describe, expect, it, vi } from "vitest";

import { resolvePathIntent } from "./appFileIntentResolver";

describe("resolvePathIntent", () => {
  it("uses an exact normalized extension and saved preference", () => {
    const resolve = vi.fn().mockReturnValue({ slug: "explorer" });
    const get = vi.fn().mockReturnValue("com.penkra.explorer");

    expect(
      resolvePathIntent({
        intents: { resolve } as never,
        kind: "file",
        openWith: { get } as never,
        path: "/workspace/README.MD",
        spaceId: "personal",
      }),
    ).toEqual({ slug: "explorer" });
    expect(get).toHaveBeenCalledWith("personal", "open-file", ".md");
    expect(resolve).toHaveBeenCalledWith("personal", {
      intent: "open-file",
      extension: ".md",
      preferredAppId: "com.penkra.explorer",
    });
  });

  it("does not classify extensionless files by reading their contents", () => {
    const resolve = vi.fn().mockReturnValue(null);

    resolvePathIntent({
      intents: { resolve } as never,
      kind: "file",
      openWith: { get: () => undefined } as never,
      path: "/workspace/Dockerfile",
      spaceId: "personal",
    });

    expect(resolve).toHaveBeenCalledWith("personal", { intent: "open-file", extension: "" });
  });
});
