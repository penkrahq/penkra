import { Effect, Schema } from "effect";
import { ProviderConnectionId, TrimmedString } from "./baseSchemas";
import { ModelSelection, ProviderKind } from "./orchestration";

const StringSetting = TrimmedString.check(Schema.isMaxLength(4096));
const CustomModels = Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
  Schema.withDecodingDefault(Effect.sync(() => [])),
);

const ManagedProviderSettingsBase = {
  // Absent means not selected yet; null explicitly selects an anonymous route.
  defaultConnectionId: Schema.optionalKey(Schema.NullOr(ProviderConnectionId)),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.sync(() => true))),
  customModels: CustomModels,
};

export const CodexServerProviderSettings = Schema.Struct({
  ...ManagedProviderSettingsBase,
});
export type CodexServerProviderSettings = typeof CodexServerProviderSettings.Type;

export const ClaudeServerProviderSettings = Schema.Struct({
  ...ManagedProviderSettingsBase,
});
export type ClaudeServerProviderSettings = typeof ClaudeServerProviderSettings.Type;

export const OpenCodeServerProviderSettings = Schema.Struct({
  ...ManagedProviderSettingsBase,
  experimentalWebSockets: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.sync(() => false))),
});
export type OpenCodeServerProviderSettings = typeof OpenCodeServerProviderSettings.Type;

const DisabledSkillNames = Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
  Schema.withDecodingDefault(Effect.sync(() => [])),
);

// User-level skill toggles. Skills are keyed by lowercased name because the
// unified catalog dedupes provider copies of the same skill by name.
export const SkillsServerSettings = Schema.Struct({
  disabled: DisabledSkillNames,
});
export type SkillsServerSettings = typeof SkillsServerSettings.Type;

export const ConversationServerSettings = Schema.Struct({
  steerComposerMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.sync(() => false))),
  steerThreadMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.sync(() => false))),
});

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.sync(() => true)),
  ),
  addProjectBaseDirectory: StringSetting.pipe(Schema.withDecodingDefault(Effect.sync(() => ""))),
  textGenerationModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  providers: Schema.Struct({
    codex: CodexServerProviderSettings.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
    claudeAgent: ClaudeServerProviderSettings.pipe(
      Schema.withDecodingDefault(Effect.sync(() => ({}))),
    ),
    opencode: OpenCodeServerProviderSettings.pipe(
      Schema.withDecodingDefault(Effect.sync(() => ({}))),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
  skills: SkillsServerSettings.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
  conversations: ConversationServerSettings.pipe(Schema.withDecodingDefault(Effect.sync(() => ({})))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

// Public settings are structurally separate so the RPC contract can remain an
// explicitly redacted boundary if server-only settings gain more fields later.
export const ServerSettingsView = ServerSettings;
export type ServerSettingsView = typeof ServerSettingsView.Type;

export const DEFAULT_SERVER_SETTINGS_VIEW: ServerSettingsView = Schema.decodeSync(
  ServerSettingsView,
)({});

const ModelSelectionPatch = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  options: Schema.optionalKey(Schema.Unknown),
});

const ProviderSettingsBasePatch = {
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(StringSetting),
  customModels: Schema.optionalKey(CustomModels),
};

const ManagedProviderSettingsBasePatch = {
  // Migration-only seed. Applied atomically only while the default is absent.
  initializeDefaultConnectionId: Schema.optionalKey(Schema.NullOr(ProviderConnectionId)),
  defaultConnectionId: Schema.optionalKey(Schema.NullOr(ProviderConnectionId)),
  enabled: Schema.optionalKey(Schema.Boolean),
  customModels: Schema.optionalKey(CustomModels),
};

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(StringSetting),
  textGenerationModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelectionPatch)),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(Schema.Struct(ManagedProviderSettingsBasePatch)),
      claudeAgent: Schema.optionalKey(Schema.Struct(ManagedProviderSettingsBasePatch)),
      opencode: Schema.optionalKey(
        Schema.Struct({
          ...ManagedProviderSettingsBasePatch,
          experimentalWebSockets: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ),
  skills: Schema.optionalKey(
    Schema.Struct({
      disabled: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(256)))),
    }),
  ),
  conversations: Schema.optionalKey(
    Schema.Struct({
      steerComposerMessages: Schema.optionalKey(Schema.Boolean),
      steerThreadMessages: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export class ServerSettingsError extends Schema.TaggedError<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}
