import { describe, expect, it } from "vitest";

import { ThreadId } from "@penkra/contracts";
import {
  isPrimaryThreadActivationIntent,
  resolveThreadCommandActivation,
} from "./threadActivation.logic";

describe("isPrimaryThreadActivationIntent", () => {
  const plainPrimary = {
    altKey: false,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };

  it("accepts an unmodified primary pointer press", () => {
    expect(isPrimaryThreadActivationIntent(plainPrimary)).toBe(true);
  });

  it.each([
    { ...plainPrimary, button: 1 },
    { ...plainPrimary, altKey: true },
    { ...plainPrimary, ctrlKey: true },
    { ...plainPrimary, metaKey: true },
    { ...plainPrimary, shiftKey: true },
  ])("rejects non-activation pointer intent %#", (intent) => {
    expect(isPrimaryThreadActivationIntent(intent)).toBe(false);
  });
});

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("resolveThreadCommandActivation", () => {
  it("opens an existing target thread", () => {
    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: true,
        activeSidebarThreadId: THREAD_B,
      }),
    ).toEqual({ kind: "single", threadId: THREAD_A });
  });

  it("ignores missing and already active threads", () => {
    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: false,
        activeSidebarThreadId: THREAD_B,
      }),
    ).toEqual({ kind: "ignore" });
    expect(
      resolveThreadCommandActivation({
        threadId: THREAD_A,
        threadExists: true,
        activeSidebarThreadId: THREAD_A,
      }),
    ).toEqual({ kind: "ignore" });
  });
});
