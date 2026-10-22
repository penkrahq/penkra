import { isDeepStrictEqual } from "node:util";
import type {
  ProviderCatalogChanged,
  ProviderCatalogData,
  ProviderCatalogKind,
  ProviderCatalogScope,
  ProviderCatalogSnapshot,
} from "@penkra/contracts";

type Entry = {
  readonly scope: ProviderCatalogScope;
  readonly attempted: Set<ProviderCatalogKind>;
  readonly pending: Set<ProviderCatalogKind>;
  readonly failures: Map<ProviderCatalogKind, string>;
  snapshot: ProviderCatalogSnapshot;
  inFlight: Promise<void> | undefined;
};

const keyFor = (scope: ProviderCatalogScope) =>
  JSON.stringify([scope.provider, scope.connectionId, scope.folderId ?? null]);

/** Server-lifetime catalog state. Provider requests are supplied by the owning layer. */
export class ProviderCatalog {
  private readonly entries = new Map<string, Entry>();

  get scopes(): ReadonlyArray<ProviderCatalogScope> {
    return [...this.entries.values()].map((entry) => entry.scope);
  }

  constructor(
    private readonly load: (
      scope: ProviderCatalogScope,
      kinds: ReadonlyArray<ProviderCatalogKind>,
    ) => Promise<ProviderCatalogData>,
    private readonly changed: (event: ProviderCatalogChanged) => void,
  ) {}

  async get(
    scope: ProviderCatalogScope,
    kinds: ReadonlyArray<ProviderCatalogKind>,
  ): Promise<ProviderCatalogSnapshot> {
    this.validate(scope, kinds);
    const entry = this.entry(scope);
    for (const kind of kinds) {
      if (!entry.attempted.has(kind)) entry.pending.add(kind);
    }
    await this.drain(entry);
    return entry.snapshot;
  }

  /** Explicit Retry shares an already-running load; it never retries on its own. */
  async reload(scope: ProviderCatalogScope): Promise<ProviderCatalogSnapshot> {
    const entry = this.entries.get(keyFor(scope));
    if (!entry) return { version: 0, error: null };
    if (!entry.inFlight) {
      for (const kind of entry.attempted) entry.pending.add(kind);
    }
    await this.drain(entry);
    return entry.snapshot;
  }

  /** Change signals affect loaded scopes only, including signals received during a load. */
  async invalidate(
    matches: (scope: ProviderCatalogScope) => boolean,
    kinds?: ReadonlyArray<ProviderCatalogKind>,
  ): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => matches(entry.scope))
        .map(async (entry) => {
          for (const kind of entry.attempted) {
            if (!kinds || kinds.includes(kind)) entry.pending.add(kind);
          }
          await this.drain(entry);
        }),
    );
  }

  /** Removing a Connection prevents a late reply from resurrecting its catalog. */
  remove(matches: (scope: ProviderCatalogScope) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (matches(entry.scope)) this.entries.delete(key);
    }
  }

  private validate(scope: ProviderCatalogScope, kinds: ReadonlyArray<ProviderCatalogKind>): void {
    if (kinds.some((kind) => (kind === "models") === (scope.folderId !== undefined))) {
      throw new Error(
        "Models require a Connection scope; other catalog kinds require a folder scope.",
      );
    }
  }

  private entry(scope: ProviderCatalogScope): Entry {
    const key = keyFor(scope);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        scope: { ...scope },
        attempted: new Set(),
        pending: new Set(),
        failures: new Map(),
        snapshot: { version: 0, error: null },
        inFlight: undefined,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private drain(entry: Entry): Promise<void> {
    if (entry.inFlight) return entry.inFlight;
    if (entry.pending.size === 0) return Promise.resolve();
    entry.inFlight = this.loadPending(entry).finally(() => {
      entry.inFlight = undefined;
    });
    return entry.inFlight;
  }

  private async loadPending(entry: Entry): Promise<void> {
    while (entry.pending.size > 0 && this.entries.get(keyFor(entry.scope)) === entry) {
      const kinds = [...entry.pending].sort();
      entry.pending.clear();
      for (const kind of kinds) entry.attempted.add(kind);
      let data: ProviderCatalogData;
      try {
        data = await this.load(entry.scope, kinds);
      } catch (cause) {
        if (this.entries.get(keyFor(entry.scope)) !== entry) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        for (const kind of kinds) entry.failures.set(kind, message);
        entry.snapshot = {
          ...entry.snapshot,
          error: message,
        };
        this.publish(entry);
        continue;
      }
      if (this.entries.get(keyFor(entry.scope)) !== entry) return;
      const { version, error: previousError, ...previousData } = entry.snapshot;
      const nextData = { ...previousData };
      // An absent kind means unsupported, including when support was removed on refresh.
      for (const kind of kinds) delete nextData[kind];
      for (const kind of kinds) {
        entry.failures.delete(kind);
        if (data[kind] !== undefined) Object.assign(nextData, { [kind]: data[kind] });
      }
      const changed = !isDeepStrictEqual(previousData, nextData);
      const error = entry.failures.values().next().value ?? null;
      entry.snapshot = { ...nextData, version: version + (changed ? 1 : 0), error };
      if (changed || previousError !== error) this.publish(entry);
    }
  }

  private publish(entry: Entry): void {
    this.changed({
      _tag: "catalog.changed",
      scope: entry.scope,
      version: entry.snapshot.version,
    });
  }
}
