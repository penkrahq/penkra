// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  router: {
    routesById: {
      "/_chat/settings": { id: "settings" },
      "/_chat/$threadId": { id: "thread" },
    },
    loadRouteChunk: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => harness.router }));
import { usePreloadRouteChunks } from "./usePreloadRouteChunks";

function PreloadRoutes() {
  usePreloadRouteChunks();
  return null;
}
let root: Root | undefined;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function expectBothChunks() {
  expect(harness.router.loadRouteChunk.mock.calls).toEqual([
    [harness.router.routesById["/_chat/settings"]],
    [harness.router.routesById["/_chat/$threadId"]],
  ]);
}

it("loads both chunks on the browser idle callback with no deadline", () => {
  let onIdle!: () => void;
  const requestIdle = vi.fn((callback: () => void) => {
    onIdle = callback;
    return 1;
  });
  vi.stubGlobal("requestIdleCallback", requestIdle);
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  act(() => root!.render(<PreloadRoutes />));
  expect(requestIdle).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
  expect(harness.router.loadRouteChunk).not.toHaveBeenCalled();
  act(() => onIdle());
  expectBothChunks();
});
it("cancels an idle callback when the route root unmounts", () => {
  const cancelIdle = vi.fn();
  vi.stubGlobal(
    "requestIdleCallback",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelIdleCallback", cancelIdle);
  act(() => root!.render(<PreloadRoutes />));
  act(() => root!.unmount());
  root = undefined;
  expect(cancelIdle).toHaveBeenCalledExactlyOnceWith(1);
  expect(harness.router.loadRouteChunk).not.toHaveBeenCalled();
});
it("loads both chunks on mount in a web browser without the idle API", () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("cancelIdleCallback", undefined);
  act(() => root!.render(<PreloadRoutes />));
  expectBothChunks();
});
