// FILE: developmentAppSideloadWatcher.ts
// Purpose: Watches one configured development sideload and coalesces rebuilds into safe reloads.
// Layer: Desktop development runtime

import * as FS from "node:fs";
import * as Path from "node:path";

type WatchHandle = {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type WatchDirectory = (
  path: string,
  options: { persistent: false; recursive: true },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => WatchHandle;

export interface DevelopmentAppSideloadWatcher {
  close(): Promise<void>;
}

export function watchDevelopmentAppSideload(input: {
  sourcePath: string;
  reload: () => Promise<void>;
  onError: (error: unknown) => void;
  debounceMs?: number;
  watchDirectory?: WatchDirectory;
}): DevelopmentAppSideloadWatcher {
  const sourcePath = Path.resolve(input.sourcePath);
  const watchRoot = Path.dirname(sourcePath);
  const debounceMs = input.debounceMs ?? 250;
  const watchDirectory =
    input.watchDirectory ??
    ((path, options, listener) => FS.watch(path, options, listener) as WatchHandle);
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let pending = false;

  const run = (): void => {
    if (closed) return;
    if (running) {
      pending = true;
      return;
    }
    running = input
      .reload()
      .catch(input.onError)
      .finally(() => {
        running = null;
        if (pending && !closed) {
          pending = false;
          schedule();
        }
      });
  };
  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
    timer.unref();
  };
  const watcher = watchDirectory(
    watchRoot,
    { persistent: false, recursive: true },
    (_eventType, filename) => {
      if (!filename) {
        schedule();
        return;
      }
      const changedPath = Path.resolve(watchRoot, filename.toString());
      const relative = Path.relative(sourcePath, changedPath);
      if (relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative))) {
        schedule();
      }
    },
  );
  watcher.on("error", input.onError);

  return {
    async close() {
      if (closed) return;
      closed = true;
      watcher.close();
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
