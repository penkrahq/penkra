import { describe, expect, it, vi } from "vitest";
import { prepareDesktopDiagnosticsWriter } from "./desktopDiagnosticsStartup";

describe("desktop diagnostics startup gate", () => {
  it("does not make a writer available when its durable queue marker fails", () => {
    const failure = new Error("marker fsync failed");
    const writer = {
      markQueueStartupActive: vi.fn(() => {
        throw failure;
      }),
      close: vi.fn(),
    };
    const acceptBufferedWrite = vi.fn();
    expect(() => acceptBufferedWrite(prepareDesktopDiagnosticsWriter(() => writer))).toThrow(
      failure,
    );
    expect(writer.close).toHaveBeenCalledOnce();
    expect(acceptBufferedWrite).not.toHaveBeenCalled();
  });
});
