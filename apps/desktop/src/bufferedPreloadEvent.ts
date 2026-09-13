export interface BufferedPreloadEvent<T> {
  publish(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

/**
 * Keeps a small event backlog until the shell installs its first React listener.
 * Electron preloads run before the shell bundle, so main-process events can otherwise
 * be lost during startup even though the underlying host state was retained.
 */
export function createBufferedPreloadEvent<T>(capacity = 128): BufferedPreloadEvent<T> {
  const listeners = new Set<(value: T) => void>();
  const pending: T[] = [];

  return {
    publish(value) {
      if (listeners.size > 0) {
        for (const listener of listeners) listener(value);
        return;
      }
      pending.push(value);
      if (pending.length > capacity) pending.splice(0, pending.length - capacity);
    },
    subscribe(listener) {
      listeners.add(listener);
      const backlog = pending.splice(0);
      for (const value of backlog) listener(value);
      return () => listeners.delete(listener);
    },
  };
}
