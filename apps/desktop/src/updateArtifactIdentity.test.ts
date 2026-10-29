import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  fingerprintUpdateArtifact,
  isUpdateArtifactIdentity,
  verifyUpdateArtifactIdentity,
} from "./updateArtifactIdentity";

const temporaryDirectories: string[] = [];

function createPayload(contents = "signed update bytes"): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-update-artifact-"));
  temporaryDirectories.push(directory);
  const filePath = Path.join(directory, "Penkra-update.zip");
  FS.writeFileSync(filePath, contents);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("update artifact identity", () => {

  it("rejects changed or missing payloads", async () => {
    const filePath = createPayload();
    const identity = await fingerprintUpdateArtifact(filePath);

    FS.writeFileSync(filePath, "different bytes");
    await expect(verifyUpdateArtifactIdentity(identity)).resolves.toBe(false);
    FS.rmSync(filePath);
    await expect(verifyUpdateArtifactIdentity(identity)).resolves.toBe(false);
  });

  it("rejects symlink payloads", async () => {
    const targetPath = createPayload();
    const symlinkPath = Path.join(Path.dirname(targetPath), "linked-update.zip");
    FS.symlinkSync(targetPath, symlinkPath);

    await expect(fingerprintUpdateArtifact(symlinkPath)).rejects.toThrow("non-symlink");
  });
});
