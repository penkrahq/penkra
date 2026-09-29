import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { recoverMissingFile } from "./missingFileRecovery";

describe("recoverMissingFile", () => {
  it("treats only missing-path errors as expected recovery", async () => {
    const recordUnexpected = vi.fn();
    for (const error of [{ code: "ENOENT" }, { reason: { _tag: "NotFound" } }]) {
      await expect(
        Effect.runPromise(recoverMissingFile(Effect.fail(error), recordUnexpected)),
      ).resolves.toBeNull();
    }
    expect(recordUnexpected).not.toHaveBeenCalled();
  });

  it("records permission and I/O errors and preserves the failure", async () => {
    const recordUnexpected = vi.fn();
    for (const error of [{ code: "EACCES" }, { code: "EIO" }, { reason: "PermissionDenied" }]) {
      await expect(
        Effect.runPromise(recoverMissingFile(Effect.fail(error), recordUnexpected)),
      ).rejects.toMatchObject(error);
    }
    expect(recordUnexpected).toHaveBeenCalledTimes(3);
  });
});
