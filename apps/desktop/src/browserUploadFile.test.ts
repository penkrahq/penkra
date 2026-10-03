import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveBrowserUploadFile } from "./browserUploadFile";

const roots: string[] = [];
async function fixture() {
  const root = await FSP.mkdtemp(Path.join(OS.tmpdir(), "penkra-browser-upload-"));
  roots.push(root);
  const base = Path.join(root, "app-storage");
  await FSP.mkdir(base);
  const outside = Path.join(root, "local.txt");
  await FSP.writeFile(outside, "harmless upload fixture");
  return { root, base, outside };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FSP.rm(root, { recursive: true, force: true })));
});

describe("explicit browser upload paths", () => {
  it("accepts absolute local files outside App storage", async () => {
    const { base, outside } = await fixture();
    expect(await resolveBrowserUploadFile(outside, base)).toBe(await FSP.realpath(outside));
  });

  it("preserves relative App-storage paths without imposing a directory boundary", async () => {
    const { base, outside } = await fixture();
    const inside = Path.join(base, "download.txt");
    await FSP.writeFile(inside, "download");
    expect(await resolveBrowserUploadFile("download.txt", base)).toBe(await FSP.realpath(inside));
    expect(await resolveBrowserUploadFile("../local.txt", base)).toBe(await FSP.realpath(outside));
  });

  it("resolves explicitly named symbolic links to regular files", async () => {
    const { base, outside } = await fixture();
    await FSP.symlink(outside, Path.join(base, "linked.txt"));
    expect(await resolveBrowserUploadFile("linked.txt", base)).toBe(await FSP.realpath(outside));
  });

  it("rejects directories, missing files and empty paths", async () => {
    const { base } = await fixture();
    await expect(resolveBrowserUploadFile(base, base)).rejects.toThrow("regular file");
    await expect(resolveBrowserUploadFile("missing.txt", base)).rejects.toThrow("ENOENT");
    await expect(resolveBrowserUploadFile(" ", base)).rejects.toThrow("file path");
  });
});
