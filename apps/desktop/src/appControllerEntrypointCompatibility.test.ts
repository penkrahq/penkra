import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FS.rm(root, { recursive: true, force: true })));
});

describe("App controller entrypoint compatibility", () => {
  it("loads a CommonJS .js controller when the App package has no package.json", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "penkra-commonjs-controller-"));
    roots.push(root);
    const entrypoint = Path.join(root, "operations.js");
    await FS.writeFile(entrypoint, "module.exports = { controllerFormat: 'commonjs' };\n");

    const loaded = await import(pathToFileURL(entrypoint).href);

    expect(loaded.default).toEqual({ controllerFormat: "commonjs" });
  });
});
