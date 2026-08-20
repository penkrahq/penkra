import { ThreadId } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import { resolveThreadBindingRevisionAtAdmission } from "./threadBindingAdmission";

describe("resolveThreadBindingRevisionAtAdmission", () => {
  const threadId = ThreadId.makeUnsafe("thread-binding-admission");

  it("uses protocol revision zero before a thread has started", async () => {
    const getThreadBinding = vi.fn();

    await expect(
      resolveThreadBindingRevisionAtAdmission({
        hasThreadStarted: false,
        loadCurrentRevision: async () => undefined,
      }),
    ).resolves.toBe(0);
    expect(getThreadBinding).not.toHaveBeenCalled();
  });

  it("uses an already-loaded exact revision without another request", async () => {
    const getThreadBinding = vi.fn();

    await expect(
      resolveThreadBindingRevisionAtAdmission({
        hasThreadStarted: true,
        cachedRevision: 7,
        loadCurrentRevision: async () => undefined,
      }),
    ).resolves.toBe(7);
    expect(getThreadBinding).not.toHaveBeenCalled();
  });

  it("loads the authoritative revision at dispatch time for a background continuation", async () => {
    const getThreadBinding = vi.fn().mockResolvedValue({
      binding: { revision: 11 },
    });

    await expect(
      resolveThreadBindingRevisionAtAdmission({
        hasThreadStarted: true,
        loadCurrentRevision: async () => (await getThreadBinding({ threadId })).binding?.revision,
      }),
    ).resolves.toBe(11);
    expect(getThreadBinding).toHaveBeenCalledWith({ threadId });
  });

  it("rejects a continuation when no exact binding can be loaded", async () => {
    const getThreadBinding = vi.fn().mockResolvedValue({ binding: null });

    await expect(
      resolveThreadBindingRevisionAtAdmission({
        hasThreadStarted: true,
        loadCurrentRevision: async () => (await getThreadBinding({ threadId })).binding?.revision,
      }),
    ).rejects.toThrow("Could not load the thread's current provider binding.");
  });
});
