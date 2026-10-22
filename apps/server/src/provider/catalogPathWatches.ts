import { statSync, watch } from "node:fs";
import path from "node:path";

type WatchHandle = { close(): void; on(event: "error", listener: (error: Error) => void): unknown };
type WatchRoot = { path: string; recursive: boolean };
type Entry = {
  readonly target: string;
  readonly listeners: Map<symbol, { changed: () => void; failed: (error: Error) => void }>;
  handle?: WatchHandle;
};

function existingWatchRoot(target: string): WatchRoot {
  let current = target;
  while (true) {
    try {
      return { path: current, recursive: current === target && statSync(current).isDirectory() };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

/** One native watch per catalog source path, shared by all loaded scopes that use it. */
export class CatalogPathWatches {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly locate: (target: string) => WatchRoot = existingWatchRoot,
    private readonly open: (
      root: WatchRoot,
      changed: (event: string, filename: string | null) => void,
    ) => WatchHandle = (root, changed) =>
      watch(root.path, { recursive: root.recursive }, (event, filename) =>
        changed(event, filename?.toString() ?? null),
      ),
  ) {}

  add(
    paths: ReadonlyArray<string>,
    changed: () => void,
    failed: (error: Error) => void,
  ): () => void {
    const subscriptions: { entry: Entry; token: symbol }[] = [];
    const release = () => {
      for (const { entry, token } of subscriptions) {
        entry.listeners.delete(token);
        if (entry.listeners.size === 0) {
          entry.handle?.close();
          this.entries.delete(entry.target);
        }
      }
    };
    try {
      for (const target of new Set(paths.map((source) => path.resolve(source)))) {
        let entry = this.entries.get(target);
        if (!entry) {
          entry = { target, listeners: new Map() };
          this.entries.set(target, entry);
        }
        const token = Symbol(target);
        entry.listeners.set(token, { changed, failed });
        subscriptions.push({ entry, token });
        if (!entry.handle) this.attach(entry);
      }
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  close(): void {
    for (const entry of this.entries.values()) entry.handle?.close();
    this.entries.clear();
  }

  private attach(entry: Entry): void {
    const root = this.locate(entry.target);
    entry.handle?.close();
    const handle = this.open(root, (event, filename) => {
      if (this.entries.get(entry.target) !== entry || entry.handle !== handle) return;
      const changedPath = filename === null ? null : path.resolve(root.path, filename);
      if (
        changedPath !== null &&
        !within(entry.target, changedPath) &&
        !within(changedPath, entry.target)
      )
        return;
      try {
        // Rename includes creation/removal of a previously missing directory and atomic replacement.
        if (event === "rename" || filename === null) this.attach(entry);
        for (const listener of entry.listeners.values()) listener.changed();
      } catch (error) {
        this.fail(entry, error instanceof Error ? error : new Error(String(error)));
      }
    });
    entry.handle = handle;
    handle.on("error", (error) => {
      if (entry.handle === handle) this.fail(entry, error);
    });
  }

  private fail(entry: Entry, error: Error): void {
    entry.handle?.close();
    delete entry.handle;
    for (const listener of entry.listeners.values()) listener.failed(error);
  }
}
