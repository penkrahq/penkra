import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awaitDesktopComposerDraftWrites,
  createDesktopComposerDraftStorage,
} from "./desktopComposerDraftStorage";
import { createMemoryStorage, type StateStorage } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("desktop composer draft storage", () => {
  it("waits for the main-process checkpoint acknowledgement", async () => {
    let resolveWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writeSnapshot = vi.fn(() => write);
    vi.stubGlobal("window", {
      desktopBridge: {
        composerDrafts: {
          readSnapshot: vi.fn().mockResolvedValue(null),
          writeSnapshot,
          removeSnapshot: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const storage = createDesktopComposerDraftStorage(createMemoryStorage());

    storage.setItem("draft", "checkpoint");
    let acknowledged = false;
    const waiting = awaitDesktopComposerDraftWrites().then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(writeSnapshot).toHaveBeenCalledWith("checkpoint");
    expect(acknowledged).toBe(false);

    resolveWrite();
    await waiting;
    expect(acknowledged).toBe(true);
  });

  it("still journals when the localStorage fallback exceeds quota", async () => {
    const writeSnapshot = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        composerDrafts: {
          readSnapshot: vi.fn().mockResolvedValue(null),
          writeSnapshot,
          removeSnapshot: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const quotaFallback: StateStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => undefined,
    };

    createDesktopComposerDraftStorage(quotaFallback).setItem("draft", "large checkpoint");
    await awaitDesktopComposerDraftWrites();

    expect(writeSnapshot).toHaveBeenCalledWith("large checkpoint");
  });
});
