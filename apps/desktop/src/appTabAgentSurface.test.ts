import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  AGENT_CURSOR_SOURCE,
  boundPageContent,
  compactSnapshot,
  diffSnapshots,
} from "./appTabAgentSurface";

describe("App tab agent surface helpers", () => {
  it("wraps untrusted page text in an unpredictable matching boundary", () => {
    const output = boundPageContent("page text", "https://example.test/");
    const nonce = /nonce=([a-f0-9]{32})/.exec(output)?.[1];
    expect(nonce).toHaveLength(32);
    expect(output).toContain(`origin=https://example.test/ ---\npage text`);
    expect(output).toContain(`END_AGENT_BROWSER_PAGE_CONTENT nonce=${nonce} ---`);
  });

  it("compacts snapshots to referenced/value lines and their ancestors", () => {
    expect(
      compactSnapshot(
        '- document "Root"\n  - generic "Wrapper"\n    - button "Save" [ref=d1:e1]\n  - generic "Noise"',
        false,
      ),
    ).toBe('- document "Root"\n  - generic "Wrapper"\n    - button "Save" [ref=d1:e1]');
  });

  it("produces a Myers-style unified line diff with counts", () => {
    expect(diffSnapshots("one\ntwo\nthree", "one\nchanged\nthree")).toMatchObject({
      additions: 1,
      removals: 1,
      unchanged: 2,
      changed: true,
      diff: expect.stringContaining("-two\n+changed"),
    });
  });
});

function cursorHarness() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const classes = new Set<string>();
  const pointer = {
    style: { display: "none", transform: "" },
    classList: {
      toggle(name: string, enabled: boolean) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      remove(name: string) {
        classes.delete(name);
      },
    },
  };
  const ripples: unknown[] = [];
  const shadow = {
    innerHTML: "",
    querySelector: () => pointer,
    insertBefore: (ripple: unknown) => ripples.push(ripple),
  };
  let removed = false;
  const context = {
    document: {
      documentElement: { appendChild() {} },
      createElement: () => ({
        style: {},
        setAttribute() {},
        attachShadow: () => shadow,
        addEventListener() {},
        remove() {
          removed = true;
        },
      }),
    },
    addEventListener(type: string, handler: (event: unknown) => void) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      listeners.get(type)?.delete(handler);
    },
    __penkraAgentCursorUpdate: undefined as
      | undefined
      | ((input: { type: string; x: number; y: number }) => void),
    __agentBrowserRecordingCursorHide: undefined as undefined | (() => void),
    __agentBrowserRecordingCursorCleanup: undefined as undefined | (() => void),
  };
  runInNewContext(AGENT_CURSOR_SOURCE, context);
  return {
    context,
    pointer,
    classes,
    ripples,
    removed: () => removed,
    dispatch(type: string, event: unknown) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
}

describe("agent cursor input", () => {
  it("ignores trusted physical pointer events, including pointerout", () => {
    const harness = cursorHarness();
    for (const type of ["pointermove", "pointerdown", "pointerup"]) {
      harness.dispatch(type, {
        type,
        isTrusted: true,
        pointerType: "mouse",
        clientX: 90,
        clientY: 100,
        buttons: 1,
      });
    }
    expect(harness.pointer.style.display).toBe("none");
    expect(harness.ripples).toHaveLength(0);
    harness.context.__penkraAgentCursorUpdate!({ type: "mouseMoved", x: 20, y: 30 });
    harness.dispatch("pointerout", { isTrusted: true, relatedTarget: null });
    expect(harness.pointer.style.display).toBe("block");
    expect(harness.pointer.style.transform).toBe("translate3d(20px,30px,0)");
  });

  it("renders agent movement, press, release and lifecycle cleanup", () => {
    const harness = cursorHarness();
    harness.context.__penkraAgentCursorUpdate!({ type: "mousePressed", x: 20, y: 30 });
    expect(harness.classes.has("pressed")).toBe(true);
    expect(harness.ripples).toHaveLength(1);
    harness.context.__penkraAgentCursorUpdate!({ type: "mouseMoved", x: 25, y: 35 });
    expect(harness.classes.has("pressed")).toBe(true);
    harness.context.__penkraAgentCursorUpdate!({ type: "mouseReleased", x: 25, y: 35 });
    expect(harness.classes.has("pressed")).toBe(false);
    harness.context.__agentBrowserRecordingCursorHide!();
    expect(harness.pointer.style.display).toBe("none");
    harness.context.__agentBrowserRecordingCursorCleanup!();
    expect(harness.removed()).toBe(true);
    expect(harness.context.__penkraAgentCursorUpdate).toBeUndefined();
  });
});
