import { describe, expect, it, vi } from "vitest";
import { readNativeApi } from "./nativeApi";

describe("readNativeApi", () => {
  it("returns the desktop API without binding turns to a window", () => {
    const dispatchCommand = vi.fn();
    const nativeApi = { orchestration: { dispatchCommand } };
    vi.stubGlobal("window", { nativeApi });
    expect(readNativeApi()).toBe(nativeApi);
    expect(readNativeApi()).toBe(nativeApi);
    vi.unstubAllGlobals();
  });
});
