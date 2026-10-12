// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useNowMs } from "./useNowMs";

it("refreshes on enable before paint and releases the live tick on disable without a deferred timer", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const now = vi.spyOn(Date, "now");
  const interval = vi.spyOn(window, "setInterval");
  const clear = vi.spyOn(window, "clearInterval");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Clock({ enabled }: { enabled: boolean }) {
    const value = useNowMs(enabled);
    return <output>{value}</output>;
  }
  try {
    act(() => root.render(<Clock enabled={false} />));
    expect(interval).not.toHaveBeenCalled();
    const reads = now.mock.calls.length;
    act(() => root.render(<Clock enabled />));
    expect(now.mock.calls.length).toBeGreaterThan(reads);
    expect(Number(container.textContent)).toBeGreaterThanOrEqual(now.mock.results[reads]?.value);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 1_000);
    const handle = interval.mock.results[0]?.value;
    act(() => root.render(<Clock enabled={false} />));
    expect(clear).toHaveBeenCalledWith(handle);
    act(() => root.render(<Clock enabled />));
    expect(interval).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
  expect(clear).toHaveBeenCalledTimes(2);
});
