import {
  FolderId,
  ProviderConnectionId,
  type ProviderCatalogChanged,
  type ProviderCatalogData,
  type ProviderCatalogScope,
} from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProviderCatalog } from "./ProviderCatalog.ts";

const connection: ProviderCatalogScope = {
  provider: "codex",
  connectionId: ProviderConnectionId.makeUnsafe("connection-a"),
};
const folder: ProviderCatalogScope = { ...connection, folderId: FolderId.makeUnsafe("folder-a") };
const models: ProviderCatalogData = { models: [{ slug: "model-a", name: "Model A" }] };
const commands: ProviderCatalogData = { commands: [{ name: "review" }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ProviderCatalog", () => {
  it("shares one scope load across concurrent callers and later reads", async () => {
    const pending = deferred<ProviderCatalogData>();
    const load = vi.fn(() => pending.promise);
    const changed = vi.fn();
    const catalog = new ProviderCatalog(load, changed);
    const reads = Array.from({ length: 10 }, () => catalog.get(folder, ["commands"]));
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(commands);
    const results = await Promise.all(reads);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(await catalog.get(folder, ["commands"])).toEqual({
      ...commands,
      version: 1,
      error: null,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      _tag: "catalog.changed",
      scope: folder,
      version: 1,
    });
  });

  it("does not serialize unrelated Connections, providers or folders", async () => {
    const pending = deferred<ProviderCatalogData>();
    const load = vi.fn(() => pending.promise);
    const catalog = new ProviderCatalog(load, vi.fn());
    const reads = [
      catalog.get(folder, ["commands"]),
      catalog.get({ ...folder, folderId: FolderId.makeUnsafe("folder-b") }, ["commands"]),
      catalog.get({ ...folder, connectionId: ProviderConnectionId.makeUnsafe("connection-b") }, [
        "commands",
      ]),
      catalog.get({ ...folder, provider: "claudeAgent" }, ["commands"]),
    ];
    expect(load).toHaveBeenCalledTimes(4);
    pending.resolve(commands);
    await Promise.all(reads);
  });

  it("rejects a mixed scope before any provider work", async () => {
    const load = vi.fn(async () => models);
    const catalog = new ProviderCatalog(load, vi.fn());
    await expect(catalog.get(folder, ["models"])).rejects.toThrow("Connection scope");
    await expect(catalog.get(connection, ["commands"])).rejects.toThrow("folder scope");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads only new kinds, coalescing their concurrent readers", async () => {
    const first = deferred<ProviderCatalogData>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ skills: [] });
    const catalog = new ProviderCatalog(load, vi.fn());
    const a = catalog.get(folder, ["commands"]);
    const b = catalog.get(folder, ["commands", "skills"]);
    const c = catalog.get(folder, ["skills"]);
    first.resolve(commands);
    await Promise.all([a, b, c]);
    expect(load.mock.calls.map((call) => call[1])).toEqual([["commands"], ["skills"]]);
    expect(await catalog.get(folder, ["commands", "skills"])).toEqual({
      ...commands,
      skills: [],
      version: 2,
      error: null,
    });
  });

  it("remembers unsupported kinds as absent rather than repeatedly loading or faking empty lists", async () => {
    const load = vi.fn(async () => ({}));
    const catalog = new ProviderCatalog(load, vi.fn());
    expect(await catalog.get(folder, ["agents", "plugins"])).toEqual({ version: 0, error: null });
    await catalog.get(folder, ["plugins", "agents"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the version and previous data on a failed reload; ordinary reads do not retry", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(models)
      .mockRejectedValue(new Error("catalog unavailable"));
    const changed = vi.fn();
    const catalog = new ProviderCatalog(load, changed);
    await catalog.get(connection, ["models"]);
    expect(await catalog.reload(connection)).toEqual({
      ...models,
      version: 1,
      error: "catalog unavailable",
    });
    await catalog.get(connection, ["models"]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith({
      _tag: "catalog.changed",
      scope: connection,
      version: 1,
    });
  });

  it("settles an initial failure, sharing explicit Retry and clearing its error on success", async () => {
    const retry = deferred<ProviderCatalogData>();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("too large"))
      .mockReturnValueOnce(retry.promise);
    const catalog = new ProviderCatalog(load, vi.fn());
    expect(await catalog.get(connection, ["models"])).toEqual({ version: 0, error: "too large" });
    await catalog.get(connection, ["models"]);
    expect(load).toHaveBeenCalledTimes(1);
    const a = catalog.reload(connection);
    const b = catalog.reload(connection);
    retry.resolve(models);
    expect(await a).toEqual({ ...models, version: 1, error: null });
    expect(await b).toEqual(await a);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("unchanged reloads keep their version, including recovery from an error", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(models)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(models);
    const changed = vi.fn();
    const catalog = new ProviderCatalog(load, changed);
    await catalog.get(connection, ["models"]);
    await catalog.reload(connection);
    expect(await catalog.reload(connection)).toEqual({ ...models, version: 1, error: null });
    expect(changed).toHaveBeenCalledTimes(3);
    await catalog.reload(connection);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("loading a different kind cannot hide an unresolved failure in the scope", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("commands failed"))
      .mockResolvedValue({ skills: [] });
    const catalog = new ProviderCatalog(load, vi.fn());
    await catalog.get(folder, ["commands"]);
    expect(await catalog.get(folder, ["skills"])).toEqual({
      skills: [],
      version: 1,
      error: "commands failed",
    });
    load.mockResolvedValue({ commands: [], skills: [] });
    expect(await catalog.reload(folder)).toEqual({
      commands: [],
      skills: [],
      version: 2,
      error: null,
    });
  });

  it("reloads only already-requested kinds of matching loaded scopes", async () => {
    const load = vi.fn(async () => commands);
    const catalog = new ProviderCatalog(load, vi.fn());
    await catalog.get(folder, ["commands"]);
    await catalog.invalidate(() => true, ["skills"]);
    await catalog.invalidate((scope) => scope.connectionId !== folder.connectionId);
    expect(load).toHaveBeenCalledTimes(1);
    await catalog.invalidate((scope) => scope.connectionId === folder.connectionId, ["commands"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not lose a real invalidation arriving during the first load", async () => {
    const first = deferred<ProviderCatalogData>();
    const load = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ commands: [{ name: "updated" }] });
    const catalog = new ProviderCatalog(load, vi.fn());
    const read = catalog.get(folder, ["commands"]);
    const invalidations = [catalog.invalidate(() => true), catalog.invalidate(() => true)];
    first.resolve(commands);
    await Promise.all([read, ...invalidations]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await catalog.get(folder, ["commands"])).toEqual({
      commands: [{ name: "updated" }],
      version: 2,
      error: null,
    });
  });

  it("removes stale data when a refreshed kind is no longer supported", async () => {
    const load = vi.fn().mockResolvedValueOnce(commands).mockResolvedValue({});
    const catalog = new ProviderCatalog(load, vi.fn());
    await catalog.get(folder, ["commands"]);
    expect(await catalog.reload(folder)).toEqual({ version: 2, error: null });
  });

  it("does not publish or resurrect a removed Connection when its old request finishes", async () => {
    const first = deferred<ProviderCatalogData>();
    const events: ProviderCatalogChanged[] = [];
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(models);
    const catalog = new ProviderCatalog(load, (event) => events.push(event));
    const old = catalog.get(connection, ["models"]);
    catalog.remove(() => true);
    first.resolve(models);
    await old;
    expect(events).toEqual([]);
    expect(await catalog.get(connection, ["models"])).toEqual({
      ...models,
      version: 1,
      error: null,
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
