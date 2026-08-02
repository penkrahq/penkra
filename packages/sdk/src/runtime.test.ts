import { afterEach, describe, expect, it, vi } from "vitest";

import { operations, tab, type PenkraAppRuntimeApi } from "./runtime";

afterEach(() => {
  delete (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra;
});

describe("framework-neutral App runtime exports", () => {
  it("forwards operation and tab registration to the preload-owned global API", () => {
    const runtime: PenkraAppRuntimeApi = {
      operations: { handle: vi.fn(() => vi.fn()) },
      tab: { handle: vi.fn(() => vi.fn()), onNavigate: vi.fn(() => vi.fn()) },
    };
    (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra = runtime;
    const operationHandler = vi.fn();
    const tabHandler = vi.fn();
    const navigationHandler = vi.fn();

    operations.handle("issues.create", operationHandler);
    tab.handle("selection.replace-text", tabHandler);
    tab.onNavigate(navigationHandler);

    expect(runtime.operations.handle).toHaveBeenCalledWith("issues.create", operationHandler);
    expect(runtime.tab.handle).toHaveBeenCalledWith("selection.replace-text", tabHandler);
    expect(runtime.tab.onNavigate).toHaveBeenCalledWith(navigationHandler);
  });

  it("fails clearly outside a Penkra App renderer", () => {
    expect(() => operations.handle("issues.create", vi.fn())).toThrow(
      "Penkra App runtime is unavailable",
    );
  });
});
