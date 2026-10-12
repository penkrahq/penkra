// @vitest-environment happy-dom
import type { ProjectListDirectoriesResult } from "@penkra/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ listDirectories: vi.fn(), connected: true }));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () =>
    harness.connected ? { folders: { listDirectories: harness.listDirectories } } : undefined,
}));
import { ComposerLocalDirectoryMenu } from "./ComposerLocalDirectoryMenu";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getAnimations",
);
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // Happy DOM does not implement the Web Animations API used by Base UI scroll areas.
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  harness.connected = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient();
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  document.body.replaceChildren();
  if (getAnimationsDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "getAnimations", getAnimationsDescriptor);
  } else {
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
  }
});
function renderMenu(mentionQuery: string, homeDir: string | null = null) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ComposerLocalDirectoryMenu
          mentionQuery={mentionQuery}
          rootLabel="Local"
          homeDir={homeDir}
          onSelectEntry={vi.fn()}
          onNavigateFolder={vi.fn()}
        />
      </QueryClientProvider>,
    ),
  );
}
function listing() {
  let resolve!: (value: ProjectListDirectoriesResult) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<ProjectListDirectoriesResult>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function result(path: string, name: string): ProjectListDirectoriesResult {
  return { entries: [{ path: `${path}/${name}`, name, kind: "file" }] };
}

it("reads a path exactly once while pending and renders its completed listing", async () => {
  const request = listing();
  harness.listDirectories.mockReturnValue(request.promise);
  renderMenu("/");
  expect(harness.listDirectories).toHaveBeenCalledExactlyOnceWith({ cwd: "/", includeFiles: true });
  expect(container.textContent).toContain("Loading local files…");
  renderMenu("/");
  expect(harness.listDirectories).toHaveBeenCalledOnce();
  await act(async () => {
    request.resolve(result("", "readme.md"));
    await request.promise;
  });
  expect(container.textContent).toContain("readme.md");
  expect(container.textContent).not.toContain("Loading local files…");
  renderMenu("/");
  expect(harness.listDirectories).toHaveBeenCalledOnce();
});
it("waits for a tilde path's home directory then reads that expanded path once", async () => {
  const request = listing();
  harness.listDirectories.mockReturnValue(request.promise);
  renderMenu("~/");
  expect(harness.listDirectories).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Waiting for home directory from server…");
  renderMenu("~/", "/home/person");
  expect(harness.listDirectories).toHaveBeenCalledExactlyOnceWith({
    cwd: "/home/person",
    includeFiles: true,
  });
  await act(async () => {
    request.resolve(result("/home/person", "home-file.txt"));
    await request.promise;
  });
  expect(container.textContent).toContain("home-file.txt");
  renderMenu("~/", "/home/person");
  expect(harness.listDirectories).toHaveBeenCalledOnce();
});
it("keeps out-of-order listing results and errors on their original paths", async () => {
  const first = listing();
  const second = listing();
  harness.listDirectories.mockImplementation(({ cwd }: { cwd: string }) =>
    cwd === "/first" ? first.promise : second.promise,
  );
  renderMenu("/first/");
  renderMenu("/second/");
  expect(harness.listDirectories.mock.calls).toEqual([
    [{ cwd: "/first", includeFiles: true }],
    [{ cwd: "/second", includeFiles: true }],
  ]);
  await act(async () => {
    second.resolve(result("/second", "second-file.txt"));
    await second.promise;
  });
  await act(async () => {
    first.reject(new Error("EACCES: permission denied"));
    await first.promise.catch(() => undefined);
  });
  expect(container.textContent).toContain("second-file.txt");
  expect(container.textContent).not.toContain("Permission denied.");
  renderMenu("/first/");
  expect(container.textContent).toContain("Permission denied.");
  expect(container.textContent).not.toContain("second-file.txt");
  expect(harness.listDirectories).toHaveBeenCalledTimes(2);
});
it("shows the existing connecting error without retrying when the API is absent", () => {
  harness.connected = false;
  renderMenu("/");
  expect(container.textContent).toContain("App is still connecting. Try again in a moment.");
  renderMenu("/");
  expect(harness.listDirectories).not.toHaveBeenCalled();
});
