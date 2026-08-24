import { beforeEach, describe, expect, it } from "vitest";

import {
  areChatScrollDiagnosticsEnabled,
  disableChatScrollDiagnostics,
  enableChatScrollDiagnostics,
  getChatScrollDiagnosticSamples,
  recordChatScrollDiagnostic,
  resetChatScrollDiagnostics,
} from "./chatScrollDiagnostics";

describe("chat scroll diagnostics", () => {
  beforeEach(() => {
    disableChatScrollDiagnostics();
    resetChatScrollDiagnostics();
  });

  it("stays inert until explicitly enabled", () => {
    expect(areChatScrollDiagnosticsEnabled()).toBe(false);
    recordChatScrollDiagnostic({
      instanceId: 1,
      event: "initial-scroll:before",
      dataCount: 193,
      anchorRevision: "193:tail",
    });

    expect(getChatScrollDiagnosticSamples()).toEqual([]);
  });

  it("captures both DOM and virtualizer end-state without transcript content", () => {
    enableChatScrollDiagnostics();
    expect(areChatScrollDiagnosticsEnabled()).toBe(true);
    recordChatScrollDiagnostic({
      instanceId: 7,
      event: "initial-scroll:checkpoint",
      dataCount: 193,
      anchorRevision: "193:tail",
      element: { scrollTop: 1_200, clientHeight: 600, scrollHeight: 2_000 },
      virtualizer: {
        scrollOffset: 1_180,
        range: { startIndex: 170, endIndex: 180 },
        getTotalSize: () => 9_000,
        getVirtualItems: () => [
          { index: 164, start: 7_200, end: 7_300, size: 100 },
          { index: 186, start: 8_700, end: 8_800, size: 100 },
        ],
        isAtEnd: () => false,
      },
      detail: { checkpoint: "1000ms" },
    });

    expect(getChatScrollDiagnosticSamples()).toEqual([
      expect.objectContaining({
        instanceId: 7,
        event: "initial-scroll:checkpoint",
        dataCount: 193,
        detail: { checkpoint: "1000ms" },
        dom: {
          scrollTop: 1_200,
          clientHeight: 600,
          scrollHeight: 2_000,
          distanceFromEnd: 200,
        },
        virtual: expect.objectContaining({
          scrollOffset: 1_180,
          totalSize: 9_000,
          isAtEnd: false,
          rangeStart: 170,
          rangeEnd: 180,
          renderedStart: 164,
          renderedEnd: 186,
          renderedCount: 2,
        }),
      }),
    ]);
  });
});
