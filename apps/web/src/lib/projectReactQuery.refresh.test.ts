// @vitest-environment happy-dom
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeApi } from "@penkra/contracts";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./appQueryClient";
import {
  invalidateProjectQueriesForWorkspaceChange,
  projectDiscoverScriptsQueryOptions,
  projectReadFileQueryOptions,
} from "./projectReactQuery";
import * as nativeApi from "../nativeApi";

afterEach(() => vi.restoreAllMocks());

it("refreshes script discovery on the production filesChanged handler without a clock advance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "penkra-script-events-"));
  const file = join(cwd, "package.json");
  await writeFile(file, JSON.stringify({ scripts: { start: "node index.js" } }));
  const discoverScripts = vi.fn(async () => {
    const { scripts } = JSON.parse(await readFile(file, "utf8")) as {
      scripts: Record<string, string>;
    };
    return {
      targets: [
        {
          cwd,
          relativePath: "",
          packageJsonPath: file,
          scripts: Object.entries(scripts).map(([name, command]) => ({ name, command })),
        },
      ],
    };
  });
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    folders: { discoverScripts },
  } as unknown as NativeApi);
  const client = createAppQueryClient();
  const options = projectDiscoverScriptsQueryOptions({ cwd });
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await client.fetchQuery(options);
    expect(discoverScripts).toHaveBeenCalledTimes(1);
    await writeFile(file, JSON.stringify({ scripts: { test: "bun test" } }));
    await invalidateProjectQueriesForWorkspaceChange(client, {
      cwd,
      filesChanged: true,
      gitChanged: false,
      lostSync: false,
    });
    expect(discoverScripts).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data?.targets[0]?.scripts).toEqual([
      { name: "test", command: "bun test" },
    ]);
    await invalidateProjectQueriesForWorkspaceChange(client, {
      cwd,
      filesChanged: false,
      gitChanged: true,
      lostSync: false,
    });
    expect(discoverScripts).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    client.clear();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("refetches an Infinity-fresh file read on a real window focus after an external edit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "penkra-file-focus-"));
  const file = join(cwd, "readme.txt");
  await writeFile(file, "before");
  const read = vi.fn(async () => ({
    relativePath: "readme.txt",
    contents: await readFile(file, "utf8"),
    truncated: false,
  }));
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    folders: { readFile: read },
  } as unknown as NativeApi);
  const client = createAppQueryClient();
  client.mount();
  const options = projectReadFileQueryOptions({ cwd, relativePath: "readme.txt" });
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await client.fetchQuery(options);
    expect(observer.getCurrentResult().data?.contents).toBe("before");
    expect(observer.getCurrentResult().isStale).toBe(false);
    await writeFile(file, "after");
    const refreshed = new Promise<void>((resolve, reject) => {
      const release = observer.subscribe((result) => {
        if (result.error) {
          release();
          reject(result.error);
        } else if (!result.isFetching && result.data?.contents === "after") {
          release();
          resolve();
        }
      });
    });
    window.dispatchEvent(new Event("focus"));
    await refreshed;
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    client.unmount();
    client.clear();
    await rm(cwd, { recursive: true, force: true });
  }
});
