// @vitest-environment happy-dom
import { act, Profiler, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Keep the form mounted while open changes; the dialog's portal/animation is not under test.
vi.mock("./ui/command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui/command")>()),
  CommandDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  CommandDialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { SidebarSearchPalette } from "./SidebarSearchPalette";

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
function props(): ComponentProps<typeof SidebarSearchPalette> {
  return {
    open: true,
    mode: "import",
    onModeChange: vi.fn(),
    onOpenChange: vi.fn(),
    actions: [],
    folders: [],
    threads: [],
    query: "",
    onQueryChange: vi.fn(),
    hasNextThreadPage: false,
    loadingThreads: false,
    onLoadNextThreadPage: vi.fn(),
    onCreateChat: vi.fn(),
    onCreateThread: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenFeedback: vi.fn(),
    onOpenUsageSettings: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenThread: vi.fn(),
    importProviders: ["codex", "claudeAgent"],
    onImportThread: vi.fn(async () => {}),
  };
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}
function typeId(value: string) {
  const input = container.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("resets import text, error and provider on close before immediate reopen", async () => {
  const input = props();
  input.onImportThread = vi.fn(async () => {
    throw new Error("Import rejected");
  });
  act(() => root.render(<SidebarSearchPalette {...input} />));
  act(() => button("Claude").click());
  act(() => typeId("previous-session"));
  await act(async () => button("Import").click());
  expect(input.onImportThread).toHaveBeenCalledWith("claudeAgent", "previous-session");
  expect(container.textContent).toContain("Import rejected");
  act(() => root.render(<SidebarSearchPalette {...input} open={false} />));
  act(() => root.render(<SidebarSearchPalette {...input} />));
  expect(container.querySelector("input")!.value).toBe("");
  expect(container.querySelector("input")!.placeholder).toBe("Paste a Codex thread id");
  expect(container.textContent).not.toContain("Import rejected");
  expect(button("Import").disabled).toBe(true);
});

it("keeps a pick across provider updates and commits an unchanged closed render once", () => {
  const input = props();
  const commits = vi.fn();
  const render = (
    open: boolean,
    providers: ComponentProps<typeof SidebarSearchPalette>["importProviders"],
  ) =>
    root.render(
      <Profiler id="palette" onRender={commits}>
        <SidebarSearchPalette {...input} open={open} importProviders={providers} />
      </Profiler>,
    );
  act(() => render(true, ["codex", "claudeAgent"]));
  act(() => button("Claude").click());
  act(() => typeId("kept-session"));
  act(() => render(true, ["claudeAgent"]));
  expect(container.querySelector("input")!.value).toBe("kept-session");
  expect(container.querySelector("input")!.placeholder).toBe("Paste a Claude session id");
  act(() => render(false, ["claudeAgent"]));
  commits.mockClear();
  act(() => render(false, ["claudeAgent"]));
  expect(commits).toHaveBeenCalledTimes(1);
  act(() => render(true, ["claudeAgent"]));
  expect(container.querySelector("input")!.value).toBe("");
  expect(container.querySelector("input")!.placeholder).toBe("Paste a Claude session id");
});
