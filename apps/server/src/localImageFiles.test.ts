import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { resolveLocalPreviewFile } from "./localImageFiles.ts";

const tempDirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "penkra-preview-"));
  tempDirs.push(root);
  mkdirSync(path.join(root, "workspace"));
  return root;
}
afterEach(() => {
  for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveLocalPreviewFile", () => {
  it.each(["image.png", "document.pdf"])(
    "resolves %s outside the workspace without a grant",
    async (name) => {
      const root = makeRoot();
      const file = path.join(root, name);
      writeFileSync(file, "preview");
      const result = await resolveLocalPreviewFile({
        requestedPath: file,
        cwd: path.join(root, "workspace"),
      });
      assert.equal(result?.path, realpathSync(file));
      assert.equal(result?.fileName, name);
      assert.equal(result?.sizeBytes, 7);
      assert.equal(
        (await resolveLocalPreviewFile({ requestedPath: file, cwd: null }))?.path,
        realpathSync(file),
      );
    },
  );

  it.each(["./local.png", "../outside.pdf"])(
    "resolves %s relative to the caller cwd",
    async (requestedPath) => {
      const root = makeRoot();
      const cwd = path.join(root, "workspace");
      const file = path.resolve(cwd, requestedPath);
      writeFileSync(file, "preview");
      const result = await resolveLocalPreviewFile({ requestedPath, cwd });
      assert.equal(result?.path, realpathSync(file));
    },
  );

  it("keeps preview format validation while explicit show accepts other files", async () => {
    const root = makeRoot();
    const requestedPath = path.join(root, "notes.txt");
    writeFileSync(requestedPath, "notes");
    assert.equal(await resolveLocalPreviewFile({ requestedPath, cwd: null }), null);
    assert.equal(
      (await resolveLocalPreviewFile({ requestedPath, cwd: null, allowAnyFile: true }))?.path,
      realpathSync(requestedPath),
    );
  });

  it("rejects missing files, directories and invalid paths", async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "directory.png"));
    for (const requestedPath of [
      null,
      "",
      "\0.png",
      path.join(root, "missing.png"),
      path.join(root, "directory.png"),
    ]) {
      assert.equal(await resolveLocalPreviewFile({ requestedPath, cwd: root }), null);
    }
  });
});
