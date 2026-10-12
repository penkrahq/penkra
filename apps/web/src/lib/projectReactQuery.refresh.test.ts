// @vitest-environment happy-dom
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeApi } from "@penkra/contracts";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./appQueryClient";
import {
  projectReadFileQueryOptions,
  projectSearchLocalEntriesQueryOptions,
} from "./projectReactQuery";
import * as nativeApi from "../nativeApi";

afterEach(() => vi.restoreAllMocks());

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

it("refreshes Infinity-fresh external-root search on focus and on its query change", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "penkra-external-focus-"));
  await writeFile(join(rootPath, "note-before.txt"), "before");
  const search = vi.fn(async ({ query }: { query: string }) => ({
    entries: (await readdir(rootPath))
      .filter((name) => name.includes(query))
      .map((name) => ({ path: join(rootPath, name), name, kind: "file" as const })),
    truncated: false,
  }));
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    folders: { searchLocalEntries: search },
  } as unknown as NativeApi);
  const client = createAppQueryClient();
  client.mount();
  const options = projectSearchLocalEntriesQueryOptions({ rootPath, query: "note" });
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await client.fetchQuery(options);
    expect(observer.getCurrentResult().isStale).toBe(false);
    await writeFile(join(rootPath, "note-after.txt"), "after");
    const refreshed = new Promise<void>((resolve, reject) => {
      const release = observer.subscribe((result) => {
        if (result.error) {
          release();
          reject(result.error);
        } else if (!result.isFetching && result.data?.entries.length === 2) {
          release();
          resolve();
        }
      });
    });
    window.dispatchEvent(new Event("focus"));
    await refreshed;
    expect(search).toHaveBeenCalledTimes(2);
    const changed = projectSearchLocalEntriesQueryOptions({ rootPath, query: "after" });
    const result = await client.fetchQuery(changed);
    expect(result.entries.map((entry) => entry.name)).toEqual(["note-after.txt"]);
    expect(search).toHaveBeenCalledTimes(3);
  } finally {
    unsubscribe();
    client.unmount();
    client.clear();
    await rm(rootPath, { recursive: true, force: true });
  }
});
