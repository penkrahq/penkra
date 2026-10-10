import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { FolderId, SpaceId } from "@penkra/contracts";
import { SidebarThreadPageEnd } from "./SidebarThreadPageEnd";
const fixture = vi.hoisted(() => ({
  pages: new Map(),
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
vi.mock("../threadListStore", () => ({
  useThreadListPages: () => fixture.pages,
  threadListScopeKey: (space: string, folder: string | null) => JSON.stringify([space, folder]),
  loadNextThreadPage: fixture.loadNext,
}));
const scope = { spaceId: SpaceId.makeUnsafe("space"), folderId: FolderId.makeUnsafe("folder") };
let report: IntersectionObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fixture.pages.clear();
  fixture.cleanup = undefined;
  fixture.loadNext.mockResolvedValue(undefined);
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
  fixture.pages.set(JSON.stringify([scope.spaceId, scope.folderId]), {
    loading: false,
    nextCursor: { id: "last" },
  });
  SidebarThreadPageEnd(scope);
  expect(observe).toHaveBeenCalledExactlyOnceWith(fixture.node);
  expect(fixture.loadNext).not.toHaveBeenCalled();
  report([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver);
  expect(fixture.loadNext).not.toHaveBeenCalled();
  report([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
  expect(fixture.loadNext).toHaveBeenCalledExactlyOnceWith(scope);
  expect(disconnect).toHaveBeenCalledOnce();
});
it("does not observe another page while loading or after the final cursor", () => {
  for (const page of [
    { loading: true, nextCursor: { id: "last" } },
    { loading: false, nextCursor: null },
  ]) {
    fixture.pages.set(JSON.stringify([scope.spaceId, scope.folderId]), page);
    SidebarThreadPageEnd(scope);
  }
  expect(observe).not.toHaveBeenCalled();
  expect(fixture.loadNext).not.toHaveBeenCalled();
});
