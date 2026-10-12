import type { TerminalEvent, NativeApi } from "@penkra/contracts";
import { afterEach, expect, it, vi } from "vitest";
import * as nativeApi from "../../nativeApi";
import {
  attachRuntimeToContainer,
  createRuntimeEntry,
  detachRuntimeFromContainer,
  disposeRuntimeEntry,
} from "./terminalRuntime";
import { enqueueTerminalResize } from "./terminalResizeQueue";
import type { TerminalRuntimeEntry } from "./terminalRuntimeTypes";

vi.mock("../../nativeApi", async (original) => ({
  ...(await original<typeof import("../../nativeApi")>()),
  readNativeApi: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: object;
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    buffer = { active: { viewportY: 0, baseY: 0, getLine: () => undefined } };
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    writes: Array<{ text: string; done?: () => void }> = [];
    constructor(options: object) {
      this.options = options;
    }
    write(text: string, done?: () => void) {
      this.writes.push({ text, ...(done ? { done } : {}) });
    }
    open() {}
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    dispose() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
  },
}));
vi.mock("./terminalRuntimeAppearance", async (original) => ({
  ...(await original<typeof import("./terminalRuntimeAppearance")>()),
  getTerminalFontFamily: () => "",
  terminalThemeFromApp: () => ({}),
}));
let entry: TerminalRuntimeEntry | undefined;
afterEach(() => {
  if (entry) disposeRuntimeEntry(entry);
  entry = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function runtime() {
  let emit!: (event: TerminalEvent) => void;
  const exited = vi.fn();
  const api = {
    terminal: {
      open: vi.fn().mockResolvedValue({
        threadId: "thread",
        terminalId: "term",
        cwd: "/workspace",
        status: "running",
        pid: 1,
        history: "existing output",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-10-11T00:00:00.000Z",
      }),
      resize: vi.fn().mockResolvedValue(undefined),
      onEvent: (listener: (event: TerminalEvent) => void) => {
        emit = listener;
        return () => {};
      },
      ackOutput: vi.fn().mockResolvedValue(undefined),
    },
  };
  vi.mocked(nativeApi.readNativeApi).mockReturnValue(api as unknown as NativeApi);
  entry = createRuntimeEntry({
    runtimeKey: "thread::term",
    threadId: "thread",
    terminalId: "term",
    terminalLabel: "Terminal",
    cwd: "/workspace",
    callbacks: {
      onSessionExited: exited,
      onTerminalMetadataChange: vi.fn(),
      onTerminalActivityChange: vi.fn(),
    },
  });
  const writes = (
    entry.terminal as unknown as { writes: Array<{ text: string; done?: () => void }> }
  ).writes;
  const event = (type: "output" | "exited") =>
    emit(
      type === "output"
        ? {
            type,
            threadId: "thread",
            terminalId: "term",
            data: "final output",
            createdAt: "2026-10-11T00:00:00.000Z",
          }
        : {
            type,
            threadId: "thread",
            terminalId: "term",
            exitCode: 0,
            exitSignal: null,
            createdAt: "2026-10-11T00:00:00.000Z",
          },
    );
  return { exited, event, writes, api };
}
it("reports exit only after final output and the exit notice have passed the native parser", () => {
  const { exited, event, writes } = runtime();
  event("output");
  event("exited");
  expect(exited).not.toHaveBeenCalled();
  expect(writes.map((write) => write.text)).toEqual([
    "final output",
    "\r\n[terminal] Process exited (code 0)\r\n",
    "",
  ]);
  writes.shift()!.done?.();
  writes.shift()!.done?.();
  expect(exited).not.toHaveBeenCalled();
  writes.shift()!.done?.();
  expect(exited).toHaveBeenCalledTimes(1);
});
it("does not deliver a queued exit after the runtime is disposed", () => {
  const { exited, event, writes } = runtime();
  event("exited");
  disposeRuntimeEntry(entry!);
  entry = undefined;
  writes.at(-1)!.done?.();
  expect(exited).not.toHaveBeenCalled();
});

it("detaching clears a pending resize so completion after reattach cannot send a stale size", async () => {
  const { api } = runtime();
  vi.spyOn(entry!.fitAddon, "fit").mockImplementation(() => {});
  let finish!: () => void;
  const request = new Promise<void>((resolve) => {
    finish = resolve;
  });
  api.terminal.resize.mockReturnValueOnce(request);
  const resolve = () => (size: { cols: number; rows: number }) => api.terminal.resize(size);
  enqueueTerminalResize(entry!, { cols: 80, rows: 24 }, resolve);
  enqueueTerminalResize(entry!, { cols: 100, rows: 30 }, resolve);
  detachRuntimeFromContainer(entry!);
  const container = document.createElement("div");
  document.body.appendChild(container);
  attachRuntimeToContainer(entry!, { isVisible: false, autoFocus: false }, container);
  finish();
  await request.catch(() => {});
  expect(api.terminal.resize).toHaveBeenCalledTimes(1);
  expect(entry!.pendingResize).toBeNull();
  expect(entry!.resizeInFlight).toBe(false);
});
