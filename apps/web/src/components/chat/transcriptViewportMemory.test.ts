import { afterEach, describe, expect, it } from "vitest";

import {
  readTranscriptViewportSnapshot,
  resetTranscriptViewportMemory,
  saveTranscriptViewportSnapshot,
} from "./transcriptViewportMemory";

describe("transcript viewport memory", () => {
  afterEach(() => resetTranscriptViewportMemory());

  it("keeps an in-memory anchor until the session cache is reset", () => {
    saveTranscriptViewportSnapshot("thread-a", {
      anchorKey: "message-a",
      anchorOffset: -42,
      isAtEnd: false,
    });

    expect(readTranscriptViewportSnapshot("thread-a")).toEqual({
      anchorKey: "message-a",
      anchorOffset: -42,
      isAtEnd: false,
    });
    resetTranscriptViewportMemory();
    expect(readTranscriptViewportSnapshot("thread-a")).toBeUndefined();
  });

  it("evicts the least recently saved viewport after the bounded capacity", () => {
    for (let index = 0; index < 33; index += 1) {
      saveTranscriptViewportSnapshot(`thread-${index}`, {
        anchorKey: `message-${index}`,
        anchorOffset: 0,
        isAtEnd: false,
      });
    }

    expect(readTranscriptViewportSnapshot("thread-0")).toBeUndefined();
    expect(readTranscriptViewportSnapshot("thread-32")?.anchorKey).toBe("message-32");
  });
});
