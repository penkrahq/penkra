import { describe, expect, it, vi } from "vitest";
import { AppTabActivation, type AppTabActivationRequest } from "./appTabActivation";

describe("explicit tab activation", () => {
  it("acknowledges claimed native presentation in the exact window", async () => {
    const activation = new AppTabActivation();
    let request!: AppTabActivationRequest;
    const done = vi.fn();
    const promise = activation
      .request("tab", 12, new AbortController().signal, (value) => {
        request = value;
      })
      .then(done);
    activation.presented("tab", 12);
    expect(done).not.toHaveBeenCalled();
    expect(activation.claim(request.requestId, 99)).toBe(false);
    expect(activation.claim(request.requestId, 12)).toBe(true);
    expect(activation.claim(request.requestId, 12)).toBe(false);
    activation.presented("tab", 99);
    expect(done).not.toHaveBeenCalled();
    activation.presented("tab", 12);
    await promise;
    expect(done).toHaveBeenCalledOnce();
  });

  it("removes cancelled requests so delayed renderer delivery cannot select the tab", async () => {
    const activation = new AppTabActivation();
    const controller = new AbortController();
    let request!: AppTabActivationRequest;
    const promise = activation.request("tab", 12, controller.signal, (value) => {
      request = value;
    });
    const rejected = expect(promise).rejects.toMatchObject({ code: "TAB_ACTIVATION_CANCELLED" });
    controller.abort(new Error("caller disconnected"));
    await rejected;
    expect(activation.claim(request.requestId, 12)).toBe(false);
  });

  it("cancels superseded requests and tab/window closure without affecting other windows", async () => {
    const activation = new AppTabActivation();
    const first = activation.request("first", 12, new AbortController().signal, () => undefined);
    const rejected = expect(first).rejects.toThrow("superseded");
    const second = activation.request("second", 12, new AbortController().signal, () => undefined);
    await rejected;
    const other = activation.request("other", 99, new AbortController().signal, () => undefined);
    const secondRejected = expect(second).rejects.toThrow("tab closed");
    activation.cancelTab("second");
    await secondRejected;
    const otherRejected = expect(other).rejects.toThrow("window closed");
    activation.cancelWindow(99);
    await otherRejected;
  });
});
