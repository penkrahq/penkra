import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SidebarThreadPageEnd } from "./SidebarThreadPageEnd";
const fixture = vi.hoisted(() => ({
  loadNext: vi.fn(),
  node: {},
  cleanup: undefined as undefined | (() => void),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useRef: () => ({ current: fixture.node }),
  useEffect: (effect: () => undefined | (() => void)) => {
    fixture.cleanup = effect();
  },
}));
let report: IntersectionObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fixture.cleanup = undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        report = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  fixture.cleanup?.();
  vi.unstubAllGlobals();
});
it("requests the next scope page only when its displayed end intersects", () => {
  SidebarThreadPageEnd({ loading: false, hasNextPage: true, onLoadNextPage: fixture.loadNext });
  expect(observe).toHaveBeenCalledExactlyOnceWith(fixture.node);
  expect(fixture.loadNext).not.toHaveBeenCalled();
  report([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver);
  expect(fixture.loadNext).not.toHaveBeenCalled();
  report([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
  expect(fixture.loadNext).toHaveBeenCalledExactlyOnceWith();
  expect(disconnect).toHaveBeenCalledOnce();
});
it("does not observe another page while loading or after the final cursor", () => {
  for (const page of [
    { loading: true, hasNextPage: true },
    { loading: false, hasNextPage: false },
  ]) {
    SidebarThreadPageEnd({ ...page, onLoadNextPage: fixture.loadNext });
  }
  expect(observe).not.toHaveBeenCalled();
  expect(fixture.loadNext).not.toHaveBeenCalled();
});
