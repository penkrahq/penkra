// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ refresh: vi.fn(), reconcile: vi.fn() }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ server: { refreshProviders: harness.refresh } }),
}));
vi.mock("../lib/serverReactQuery", () => ({ reconcileServerProviderStatuses: harness.reconcile }));
import { useProviderAuthRefreshOnFocus } from "./useProviderAuthRefreshOnFocus";

function ProbeOnFocus() {
  useProviderAuthRefreshOnFocus();
  return null;
}
let root: Root | undefined;
let client: QueryClient;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient();
});
afterEach(() => {
  act(() => root?.unmount());
  client.clear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function mount() {
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <ProbeOnFocus />
      </QueryClientProvider>,
    ),
  );
}
function probe() {
  let resolve!: (value: { providers: [] }) => void;
  const promise = new Promise<{ providers: [] }>((complete) => {
    resolve = complete;
  });
  harness.refresh.mockReturnValue(promise);
  return { promise, resolve };
}
it("refreshes on real focus and reconciles the resolved probe", async () => {
  const request = probe();
  mount();
  expect(harness.refresh).not.toHaveBeenCalled();
  act(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(harness.refresh).toHaveBeenCalledOnce();
  expect(harness.reconcile).not.toHaveBeenCalled();
  await act(async () => {
    request.resolve({ providers: [] });
    await request.promise;
  });
  expect(harness.reconcile).toHaveBeenCalledWith(client, []);
});
it("does not reconcile a late probe or refresh again after unmount", async () => {
  const request = probe();
  mount();
  act(() => window.dispatchEvent(new Event("focus")));
  act(() => root!.unmount());
  root = undefined;
  await act(async () => {
    request.resolve({ providers: [] });
    await request.promise;
  });
  expect(harness.reconcile).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(harness.refresh).toHaveBeenCalledOnce();
});
