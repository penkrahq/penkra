import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awaitDesktopComposerDraftWrites,
  createDesktopComposerDraftStorage,
} from "./desktopComposerDraftStorage";
import { createMemoryStorage } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("desktop composer durability failure evidence", () => {
  it("propagates a rejected desktop journal write through the acknowledgement promise", async () => {
    const failure = new Error("journal unavailable");
    vi.stubGlobal("window", {
      desktopBridge: {
        composerDrafts: {
          readSnapshot: vi.fn().mockResolvedValue(null),
          writeSnapshot: vi.fn().mockRejectedValue(failure),
          removeSnapshot: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    createDesktopComposerDraftStorage(createMemoryStorage()).setItem("draft", "checkpoint");

    await expect(awaitDesktopComposerDraftWrites()).rejects.toThrow("journal unavailable");
  });
});
