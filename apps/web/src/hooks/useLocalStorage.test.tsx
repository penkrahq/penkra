// @vitest-environment happy-dom
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLocalStorageItem, useLocalStorage } from "./useLocalStorage";

const roots: Root[] = [];
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  return { container, root };
}
function Setting({ storageKey }: { storageKey: string }) {
  const [value, setValue] = useLocalStorage(storageKey, "empty", Schema.String);
  return <button onClick={() => setValue((previous) => `${previous}!`)}>{value}</button>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
});
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
});

describe("useLocalStorage", () => {
  it("switches keys before committing a stale value and writes only the new key", async () => {
    setLocalStorageItem("first", "Alpha", Schema.String);
    setLocalStorageItem("second", "Beta", Schema.String);
    const { root, container } = mount();
    act(() => root.render(<Setting storageKey="first" />));
    expect(container.textContent).toBe("Alpha");
    act(() => root.render(<Setting storageKey="second" />));
    expect(container.textContent).toBe("Beta");
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Beta!");
    expect(window.localStorage.getItem("first")).toBe(JSON.stringify("Alpha"));
    expect(window.localStorage.getItem("second")).toBe(JSON.stringify("Beta!"));
  });

  it("keeps same-window and other-window storage event synchronization", async () => {
    setLocalStorageItem("shared", "Initial", Schema.String);
    const first = mount();
    const second = mount();
    act(() => {
      first.root.render(<Setting storageKey="shared" />);
      second.root.render(<Setting storageKey="shared" />);
    });
    await act(async () => first.container.querySelector("button")!.click());
    expect(first.container.textContent).toBe("Initial!");
    expect(second.container.textContent).toBe("Initial!");
    act(() => {
      setLocalStorageItem("shared", "External", Schema.String);
      window.dispatchEvent(new StorageEvent("storage", { key: "shared" }));
    });
    expect(first.container.textContent).toBe("External");
    expect(second.container.textContent).toBe("External");
  });
});
