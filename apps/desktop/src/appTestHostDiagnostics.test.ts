import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createAppTestHostDiagnosticWriter } from "./appTestHostDiagnostics";

class DiagnosticStream extends EventEmitter {
  readonly write = vi.fn((_message: string, callback?: (error?: Error | null) => void) => {
    callback?.(null);
    return true;
  });
}

describe("App test host diagnostics", () => {
  it("stops writing when the supervising pipe closes", () => {
    const stream = new DiagnosticStream();
    const diagnostics = createAppTestHostDiagnosticWriter(stream as never);

    diagnostics.write("first\n");
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    diagnostics.write("second\n");

    expect(stream.write).toHaveBeenCalledOnce();
    expect(stream.listenerCount("error")).toBe(1);
    diagnostics.close();
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("treats synchronous and callback write failures as diagnostic loss", () => {
    const synchronous = new DiagnosticStream();
    synchronous.write.mockImplementationOnce(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    const syncDiagnostics = createAppTestHostDiagnosticWriter(synchronous as never);
    expect(() => syncDiagnostics.write("first\n")).not.toThrow();
    syncDiagnostics.write("second\n");
    expect(synchronous.write).toHaveBeenCalledOnce();

    const callback = new DiagnosticStream();
    callback.write.mockImplementationOnce((_message, done) => {
      done?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      return false;
    });
    const callbackDiagnostics = createAppTestHostDiagnosticWriter(callback as never);
    callbackDiagnostics.write("first\n");
    callbackDiagnostics.write("second\n");
    expect(callback.write).toHaveBeenCalledOnce();
  });
});
