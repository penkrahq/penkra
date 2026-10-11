import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { recoverMissingFile } from "./missingFileRecovery";

describe("recoverMissingFile", () => {
  it("treats only missing-path errors as expected recovery", async () => {
    for (const error of [{ code: "ENOENT" }, { reason: { _tag: "NotFound" } }]) {
      await expect(Effect.runPromise(recoverMissingFile(Effect.fail(error)))).resolves.toBeNull();
    }
  });

  it("preserves permission and I/O failures", async () => {
    for (const error of [{ code: "EACCES" }, { code: "EIO" }, { reason: "PermissionDenied" }]) {
      await expect(Effect.runPromise(recoverMissingFile(Effect.fail(error)))).rejects.toMatchObject(
        error,
      );
    }
  });
});
