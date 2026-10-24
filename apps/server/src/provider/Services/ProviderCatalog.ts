import type {
  ProviderCatalogChanged,
  ProviderCatalogKind,
  ProviderCatalogScope,
  ProviderCatalogSnapshot,
} from "@penkra/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface ProviderCatalogServiceShape {
  readonly get: (
    scope: ProviderCatalogScope,
    kinds: ReadonlyArray<ProviderCatalogKind>,
  ) => Effect.Effect<ProviderCatalogSnapshot, Error>;
  readonly reload: (scope: ProviderCatalogScope) => Effect.Effect<ProviderCatalogSnapshot, Error>;
  readonly invalidate: (
    matches: (scope: ProviderCatalogScope) => boolean,
    kinds?: ReadonlyArray<ProviderCatalogKind>,
  ) => Effect.Effect<void, Error>;
  readonly remove: (matches: (scope: ProviderCatalogScope) => boolean) => Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<ProviderCatalogChanged>;
}

export class ProviderCatalogService extends Context.Service<
  ProviderCatalogService,
  ProviderCatalogServiceShape
>()("penkra/provider/ProviderCatalog") {}
