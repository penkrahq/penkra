import { Schema } from "effect";
import { FolderId, NonNegativeInt, ProviderConnectionId } from "./baseSchemas";
import {
  ProviderAgentDescriptor,
  ProviderModelDescriptor,
  ProviderNativeCommandDescriptor,
  ProviderPluginMarketplaceDescriptor,
  ProviderSkillDescriptor,
} from "./providerDiscovery";

export const ProviderCatalogKind = Schema.Literals([
  "models",
  "commands",
  "skills",
  "plugins",
  "agents",
]);
export type ProviderCatalogKind = typeof ProviderCatalogKind.Type;

export const ProviderCatalogScope = Schema.Struct({
  provider: Schema.Literals(["codex", "claudeAgent", "opencode"]),
  connectionId: Schema.NullOr(ProviderConnectionId),
  folderId: Schema.optional(FolderId),
});
export type ProviderCatalogScope = typeof ProviderCatalogScope.Type;

export const ProviderCatalogData = Schema.Struct({
  models: Schema.optional(Schema.Array(ProviderModelDescriptor)),
  commands: Schema.optional(Schema.Array(ProviderNativeCommandDescriptor)),
  skills: Schema.optional(Schema.Array(ProviderSkillDescriptor)),
  plugins: Schema.optional(Schema.Array(ProviderPluginMarketplaceDescriptor)),
  agents: Schema.optional(Schema.Array(ProviderAgentDescriptor)),
});
export type ProviderCatalogData = typeof ProviderCatalogData.Type;

export const ProviderCatalogSnapshot = Schema.Struct({
  ...ProviderCatalogData.fields,
  version: NonNegativeInt,
  error: Schema.NullOr(Schema.String),
});
export type ProviderCatalogSnapshot = typeof ProviderCatalogSnapshot.Type;

export const ProviderCatalogChanged = Schema.TaggedStruct("catalog.changed", {
  scope: ProviderCatalogScope,
  version: NonNegativeInt,
});
export type ProviderCatalogChanged = typeof ProviderCatalogChanged.Type;
