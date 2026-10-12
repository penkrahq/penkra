// @vitest-environment happy-dom
import type { SearchAddon } from "@xterm/addon-search";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalSearch } from "./TerminalSearch";

function addon() {
  const listeners = new Set<Parameters<SearchAddon["onDidChangeResults"]>[0]>();
  let resultCount = 1;
  const emit = (count: number) => {
    for (const listener of listeners) listener({ resultCount: count, resultIndex: count ? 0 : -1 });
  };
  const dispose = vi.fn();
  const search = vi.fn(() => {
    emit(resultCount);
    return resultCount > 0;
  });
  const previous = vi.fn(() => {
    emit(resultCount);
    return resultCount > 0;
  });
  const clear = vi.fn(() => emit(0));
  const instance = {
    findNext: search,
    findPrevious: previous,
    clearDecorations: clear,
    onDidChangeResults: (listener: Parameters<SearchAddon["onDidChangeResults"]>[0]) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
          dispose();
        },
      };
    },
  } as unknown as SearchAddon;
  return {
    instance,
    search,
    previous,
    clear,
    dispose,
    emit,
    results: (count: number) => {
      resultCount = count;
    },
  };
}
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});
function typeQuery(value: string) {
  const input = container.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function click(label: string) {
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
}

it("searches each input and presents the result event without a debounce", () => {
  const terminal = addon();
  terminal.results(0);
  act(() =>
    root.render(<TerminalSearch searchAddon={terminal.instance} isOpen onClose={vi.fn()} />),
  );
  act(() => typeQuery("a"));
  act(() => typeQuery("ab"));
  expect(terminal.search.mock.calls).toHaveLength(2);
  expect(terminal.search).toHaveBeenNthCalledWith(
    1,
    "a",
    expect.objectContaining({
      caseSensitive: false,
      regex: false,
      decorations: expect.any(Object),
    }),
  );
  expect(terminal.search).toHaveBeenNthCalledWith(2, "ab", expect.any(Object));
  expect(container.textContent).toContain("No results");
  act(() => terminal.emit(1));
  expect(container.textContent).not.toContain("No results");
  act(() => typeQuery(""));
  expect(terminal.clear).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("No results");
});

it("searches on case/addon changes and unsubscribes from the old addon", () => {
  const first = addon();
  const second = addon();
  act(() => root.render(<TerminalSearch searchAddon={first.instance} isOpen onClose={vi.fn()} />));
  act(() => typeQuery("Word"));
  act(() => click("Match case"));
  expect(first.search).toHaveBeenLastCalledWith(
    "Word",
    expect.objectContaining({ caseSensitive: true }),
  );
  act(() => root.render(<TerminalSearch searchAddon={second.instance} isOpen onClose={vi.fn()} />));
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(second.search).toHaveBeenCalledWith(
    "Word",
    expect.objectContaining({ caseSensitive: true }),
  );
  act(() => first.emit(0));
  expect(container.textContent).not.toContain("No results");
});

it("keeps next/previous, Escape and close/clear behaviour", () => {
  const terminal = addon();
  const onClose = vi.fn();
  act(() =>
    root.render(<TerminalSearch searchAddon={terminal.instance} isOpen onClose={onClose} />),
  );
  act(() => typeQuery("match"));
  terminal.search.mockClear();
  act(() => click("Next match (Enter)"));
  act(() => click("Previous match (Shift+Enter)"));
  act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })),
  );
  expect(terminal.search).toHaveBeenCalledTimes(2);
  expect(terminal.previous).toHaveBeenCalledTimes(2);
  act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(onClose).toHaveBeenCalledOnce();
  act(() => click("Close search (Esc)"));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(container.querySelector("input")!.value).toBe("");
  act(() =>
    root.render(
      <TerminalSearch searchAddon={terminal.instance} isOpen={false} onClose={onClose} />,
    ),
  );
  expect(terminal.clear).toHaveBeenCalledOnce();
  expect(container.childElementCount).toBe(0);
});
