// FILE: findCoordinator.ts
// Purpose: Coordinates exact find-in-open-view results across independently searchable surfaces.
// Layer: Web application infrastructure
// Exports: FindCoordinator, FindSurface, FindState

export interface FindSurfaceResult {
  readonly count: number;
}

export interface FindSurface {
  readonly id: string;
  /** Lower orders are visited first by Enter. Keep this aligned with visual pane order. */
  readonly order: number;
  /** Override the coordinator deadline for surfaces such as large document indexes. */
  readonly searchTimeoutMs?: number;
  isVisible(): boolean;
  search(query: string, generation: number): Promise<FindSurfaceResult> | FindSurfaceResult;
  activate(matchIndex: number): Promise<void> | void;
  clear(): void;
  subscribeInvalidation?(listener: () => void): () => void;
}

interface SurfaceSnapshot {
  readonly surface: FindSurface;
  readonly count: number;
}

export interface FindState {
  readonly query: string;
  readonly current: number;
  readonly total: number;
  readonly pending: boolean;
}

const EMPTY_STATE: FindState = {
  query: "",
  current: 0,
  total: 0,
  pending: false,
};

const DEFAULT_SEARCH_TIMEOUT_MS = 3_000;

function isSurfaceVisible(surface: FindSurface): boolean {
  try {
    return surface.isVisible();
  } catch {
    return false;
  }
}

async function searchSurface(
  surface: FindSurface,
  query: string,
  generation: number,
): Promise<FindSurfaceResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      Promise.resolve(surface.search(query, generation)),
      new Promise<FindSurfaceResult>((resolve) => {
        timeout = setTimeout(
          () => resolve({ count: 0 }),
          surface.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
        );
      }),
    ]);
    return result && Number.isInteger(result.count) ? result : { count: 0 };
  } catch {
    return { count: 0 };
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

export class FindCoordinator {
  readonly #surfaces = new Map<string, FindSurface>();
  readonly #surfaceInvalidationCleanups = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #state: FindState = EMPTY_STATE;
  #results: SurfaceSnapshot[] = [];
  #activeSurfaceId: string | null = null;
  #activeLocalIndex = -1;
  #runningGeneration: number | null = null;
  #refreshQueued = false;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  getSnapshot = (): FindState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  register(surface: FindSurface): () => void {
    if (this.#disposed) return () => {};
    if (this.#surfaces.has(surface.id)) {
      throw new Error(`Find surface "${surface.id}" is already registered`);
    }
    this.#surfaces.set(surface.id, surface);
    if (surface.subscribeInvalidation) {
      this.#surfaceInvalidationCleanups.set(
        surface.id,
        surface.subscribeInvalidation(() => {
          this.#scheduleRefresh();
        }),
      );
    }
    this.#scheduleRefresh();

    return () => {
      this.#surfaceInvalidationCleanups.get(surface.id)?.();
      this.#surfaceInvalidationCleanups.delete(surface.id);
      this.#surfaces.delete(surface.id);
      surface.clear();
      this.#scheduleRefresh();
    };
  }

  setQuery(query: string): void {
    if (query === this.#state.query) return;
    this.#refreshQueued = false;
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#activeSurfaceId = null;
    this.#activeLocalIndex = -1;
    if (!query) {
      this.#generation += 1;
      this.#results = [];
      for (const surface of this.#surfaces.values()) surface.clear();
      this.#setState(EMPTY_STATE);
      return;
    }
    void this.#runSearch(query, false);
  }

  async next(): Promise<void> {
    await this.#move(1);
  }

  async previous(): Promise<void> {
    await this.#move(-1);
  }

  clear(): void {
    this.setQuery("");
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#refreshQueued = false;
    for (const cleanup of this.#surfaceInvalidationCleanups.values()) cleanup();
    for (const surface of this.#surfaces.values()) surface.clear();
    this.#surfaceInvalidationCleanups.clear();
    this.#surfaces.clear();
    this.#listeners.clear();
  }

  async #runSearch(query: string, preserveActive: boolean): Promise<void> {
    const generation = ++this.#generation;
    this.#runningGeneration = generation;
    this.#setState({
      ...this.#state,
      query,
      pending: preserveActive ? this.#state.pending : true,
    });

    try {
      const visible = [...this.#surfaces.values()]
        .filter(isSurfaceVisible)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
      // Do not let a native browser view, PDF worker, or background-throttled
      // renderer hold the global UI on "Searching…". Fast surfaces replace this
      // provisional empty state as soon as their promises settle.
      if (!preserveActive) {
        this.#results = [];
        this.#setState({
          query,
          current: 0,
          total: 0,
          pending: false,
        });
      }
      const settledBySurfaceId = new Map<string, FindSurfaceResult>();
      if (preserveActive) {
        for (const result of this.#results) {
          settledBySurfaceId.set(result.surface.id, { count: result.count });
        }
      }
      await Promise.all(
        visible.map(async (surface) => {
          const result = await searchSurface(surface, query, generation);
          if (this.#disposed || generation !== this.#generation) return;
          settledBySurfaceId.set(surface.id, result);

          const previousActiveSurfaceId = this.#activeSurfaceId;
          const previousActiveLocalIndex = this.#activeLocalIndex;
          this.#results = visible.flatMap((candidate) => {
            const candidateResult = settledBySurfaceId.get(candidate.id);
            return candidateResult &&
              Number.isInteger(candidateResult.count) &&
              candidateResult.count > 0
              ? [{ surface: candidate, count: candidateResult.count }]
              : [];
          });
          const total = this.#results.reduce((sum, candidate) => sum + candidate.count, 0);
          const retained = this.#results.find(
            (candidate) => candidate.surface.id === previousActiveSurfaceId,
          );
          if (
            retained &&
            previousActiveLocalIndex >= 0 &&
            previousActiveLocalIndex < retained.count
          ) {
            this.#activeSurfaceId = retained.surface.id;
            this.#activeLocalIndex = previousActiveLocalIndex;
          } else {
            const first = this.#results[0];
            this.#activeSurfaceId = first?.surface.id ?? null;
            this.#activeLocalIndex = first ? 0 : -1;
          }
          this.#setState({
            query,
            current: this.#globalOrdinal(),
            total,
            pending: false,
          });
          if (!retained && this.#results[0]) {
            try {
              await this.#results[0].surface.activate(0);
            } catch {
              // A detached result may fail to reveal while other surfaces remain usable.
            }
          }
        }),
      );
    } catch {
      if (!this.#disposed && generation === this.#generation) {
        this.#results = [];
        this.#activeSurfaceId = null;
        this.#activeLocalIndex = -1;
        this.#setState({
          query,
          current: 0,
          total: 0,
          pending: false,
        });
      }
    } finally {
      if (this.#runningGeneration !== generation) return;
      this.#runningGeneration = null;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        this.#scheduleRefresh();
      }
    }
  }

  #scheduleRefresh(): void {
    if (this.#disposed || !this.#state.query) return;
    if (this.#runningGeneration !== null) {
      this.#refreshQueued = true;
      return;
    }
    if (this.#refreshTimer !== null) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      if (this.#state.query) void this.#runSearch(this.#state.query, true);
    }, 16);
  }

  async #move(direction: 1 | -1): Promise<void> {
    const total = this.#results.reduce((sum, result) => sum + result.count, 0);
    if (total === 0) return;

    let globalIndex = this.#globalOrdinal() - 1;
    if (globalIndex < 0) globalIndex = direction === 1 ? 0 : total - 1;
    else globalIndex = (globalIndex + direction + total) % total;

    let offset = 0;
    for (const result of this.#results) {
      if (globalIndex < offset + result.count) {
        this.#activeSurfaceId = result.surface.id;
        this.#activeLocalIndex = globalIndex - offset;
        this.#setState({ ...this.#state, current: globalIndex + 1 });
        await result.surface.activate(this.#activeLocalIndex);
        return;
      }
      offset += result.count;
    }
  }

  #globalOrdinal(): number {
    if (this.#activeSurfaceId === null || this.#activeLocalIndex < 0) return 0;
    let offset = 0;
    for (const result of this.#results) {
      if (result.surface.id === this.#activeSurfaceId) {
        return offset + this.#activeLocalIndex + 1;
      }
      offset += result.count;
    }
    return 0;
  }

  #setState(next: FindState): void {
    if (
      next.query === this.#state.query &&
      next.current === this.#state.current &&
      next.total === this.#state.total &&
      next.pending === this.#state.pending
    ) {
      return;
    }
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
