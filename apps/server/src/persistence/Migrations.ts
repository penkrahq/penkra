/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationLineageError, MigrationSchemaTooNewError } from "./Errors.ts";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ThreadHandoffMetadata.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadMessageMentions.ts";
import Migration0019 from "./Migrations/019_ProjectionThreadsEnvMode.ts";
import Migration0020 from "./Migrations/020_ProjectionThreadsForkSource.ts";
import Migration0021 from "./Migrations/021_ProjectionThreadsAssociatedWorktree.ts";
import Migration0022 from "./Migrations/022_ProjectionThreadsAssociatedWorktreeBranch.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadsAssociatedWorktreeRef.ts";
import Migration0024 from "./Migrations/024_ProjectionThreadsArchivedAt.ts";
import Migration0025 from "./Migrations/025_ProjectionThreadsSubagents.ts";
import Migration0026 from "./Migrations/026_ProjectionThreadShellSummary.ts";
import Migration0027 from "./Migrations/027_BackfillProjectionThreadShellSummary.ts";
import Migration0028 from "./Migrations/028_ProjectionProjectsKind.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadsLastKnownPr.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadMessagesDispatchMode.ts";
import Migration0031 from "./Migrations/031_ProjectionThreadsCreateBranchFlowCompleted.ts";
import Migration0032 from "./Migrations/032_ReconcileImportedSchemaLineage.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSidechatSource.ts";
import Migration0034 from "./Migrations/034_AuthAccessManagement.ts";
import Migration0035 from "./Migrations/035_NormalizeLegacyModelSelectionOptions.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionSnapshotCapIndexes.ts";
import Migration0038 from "./Migrations/038_ReconcileLegacySidechatSource.ts";
import Migration0039 from "./Migrations/039_ReconcileLegacyPinnedThreads.ts";
import Migration0040 from "./Migrations/040_ProjectionThreadsPinnedMessagesNotes.ts";
import Migration0041 from "./Migrations/041_ProjectionProjectsPinned.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadsMarkers.ts";
import Migration0043 from "./Migrations/043_ProfileStatsIndexes.ts";
import Migration0044 from "./Migrations/044_Automations.ts";
import Migration0045 from "./Migrations/045_AutomationPolicies.ts";
import Migration0046 from "./Migrations/046_AutomationCompletionPolicy.ts";
import Migration0047 from "./Migrations/047_AutomationCompletionPolicyVersion.ts";
import Migration0048 from "./Migrations/048_AutomationCompletionEvaluationBacklog.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadMessagesDispatchOrigin.ts";
import Migration0050 from "./Migrations/050_ProfileStatsArchive.ts";
import Migration0051 from "./Migrations/051_ProfileStatsDeletedTokensModel.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadUserMessageSummaryIndex.ts";
import Migration0053 from "./Migrations/053_BackfillThreadActivitySequence.ts";
import Migration0054 from "./Migrations/054_ReservedDurableProviderCommandDelivery.ts";
import Migration0055 from "./Migrations/055_ManagedAttachments.ts";
import Migration0056 from "./Migrations/056_CommandReceiptFingerprints.ts";
import Migration0057 from "./Migrations/057_ThreadScopedProjectionMessageIdentity.ts";
import Migration0058 from "./Migrations/058_ThreadScopedPendingApprovalIdentity.ts";
import Migration0059 from "./Migrations/059_ProviderSessionLifecycleGeneration.ts";
import Migration0060 from "./Migrations/060_PendingApprovalLifecycleGeneration.ts";
import Migration0061 from "./Migrations/061_PendingApprovalSettlementState.ts";
import Migration0062 from "./Migrations/062_PendingInteractionSettlementParity.ts";
import Migration0063 from "./Migrations/063_ProjectionMessageCausalSequence.ts";
import Migration0064 from "./Migrations/064_DurableProviderCommandDelivery.ts";
import Migration0065 from "./Migrations/065_DurableQueuedTurnPromotions.ts";
import Migration0066 from "./Migrations/066_DurableProviderRuntimeEvents.ts";
import Migration0067 from "./Migrations/067_ProviderDeliveryReconciliation.ts";
import Migration0068 from "./Migrations/068_GitHandoffOperations.ts";
import Migration0069 from "./Migrations/069_ProjectPullRequestPins.ts";
import Migration0070 from "./Migrations/070_AgentGatewayOperations.ts";
import Migration0071 from "./Migrations/071_ProjectionThreadsGatewayProvenance.ts";
import Migration0072 from "./Migrations/072_AgentGatewayOperationRetention.ts";
import Migration0073 from "./Migrations/073_OperationalDiagnostics.ts";
import Migration0079 from "./Migrations/079_Spaces.ts";
import Migration0080 from "./Migrations/080_PruneRejectedProductSurfaces.ts";
import Migration0086 from "./Migrations/086_NormalizeStudioThreadWorkspaces.ts";
import Migration0087 from "./Migrations/087_DropUnusedOrchestrationEventIndexes.ts";
import Migration0088 from "./Migrations/088_ProjectionThreadsSpaces.ts";
import Migration0089 from "./Migrations/089_ProjectionSpacesArchive.ts";
import Migration0090 from "./Migrations/090_ThreadScopedProviderRuntimeProjection.ts";
import Migration0091 from "./Migrations/091_SpaceNavigationState.ts";
import Migration0092 from "./Migrations/092_RemoveProjectionThreadWorktreePath.ts";
import Migration0093 from "./Migrations/093_VirtualFolders.ts";
import Migration0094 from "./Migrations/094_RequireSpaces.ts";
import Migration0095 from "./Migrations/095_SidebarManualOrdering.ts";
import Migration0096 from "./Migrations/096_RemoveSidechatAndProviderHandoff.ts";
import Migration0097 from "./Migrations/097_RenameGitThreadEnvironmentOperations.ts";
import Migration0098 from "./Migrations/098_ProviderConnectionsAndBindings.ts";
import Migration0099 from "./Migrations/099_ProviderThreadSwitchOperations.ts";
import Migration0100 from "./Migrations/100_ReconcileProviderConnectionSchema.ts";
import Migration0101 from "./Migrations/101_ExactProviderNativeStateMigration.ts";
import Migration0102 from "./Migrations/102_ProviderConnectionLogins.ts";
import Migration0103 from "./Migrations/103_DefaultNewSpacesAndConnections.ts";
import Migration0104 from "./Migrations/104_ProviderNativeStateOwnership.ts";
import Migration0105 from "./Migrations/105_ProviderNativeForkOperations.ts";
import Migration0106 from "./Migrations/106_RemovePlanMode.ts";
import Migration0107 from "./Migrations/107_ReconcileUnavailableSpaceConnectionDefaults.ts";
import Migration0108 from "./Migrations/108_RemoveLegacyClaudeSetupTokenConnections.ts";
import Migration0109 from "./Migrations/109_ProviderRuntimeBindingSwitchOperations.ts";
import Migration0110 from "./Migrations/110_SettleProviderSwitchSource.ts";
import Migration0111 from "./Migrations/111_DerivedProviderConnectionLabels.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ThreadHandoffMetadata", Migration0017],
  [18, "ProjectionThreadMessageMentions", Migration0018],
  [19, "ProjectionThreadsEnvMode", Migration0019],
  [20, "ProjectionThreadsForkSource", Migration0020],
  [21, "ProjectionThreadsAssociatedWorktree", Migration0021],
  [22, "ProjectionThreadsAssociatedWorktreeBranch", Migration0022],
  [23, "ProjectionThreadsAssociatedWorktreeRef", Migration0023],
  [24, "ProjectionThreadsArchivedAt", Migration0024],
  [25, "ProjectionThreadsSubagents", Migration0025],
  [26, "ProjectionThreadShellSummary", Migration0026],
  [27, "BackfillProjectionThreadShellSummary", Migration0027],
  [28, "ProjectionProjectsKind", Migration0028],
  [29, "ProjectionThreadsLastKnownPr", Migration0029],
  [30, "ProjectionThreadMessagesDispatchMode", Migration0030],
  [31, "ProjectionThreadsCreateBranchFlowCompleted", Migration0031],
  [32, "ReconcileImportedSchemaLineage", Migration0032],
  [33, "ProjectionThreadsSidechatSource", Migration0033],
  [34, "AuthAccessManagement", Migration0034],
  [35, "NormalizeLegacyModelSelectionOptions", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionSnapshotCapIndexes", Migration0037],
  [38, "ReconcileLegacySidechatSource", Migration0038],
  [39, "ReconcileLegacyPinnedThreads", Migration0039],
  [40, "ProjectionThreadsPinnedMessagesNotes", Migration0040],
  [41, "ProjectionProjectsPinned", Migration0041],
  [42, "ProjectionThreadsMarkers", Migration0042],
  [43, "ProfileStatsIndexes", Migration0043],
  [44, "Automations", Migration0044],
  [45, "AutomationPolicies", Migration0045],
  [46, "AutomationCompletionPolicy", Migration0046],
  [47, "AutomationCompletionPolicyVersion", Migration0047],
  [48, "AutomationCompletionEvaluationBacklog", Migration0048],
  [49, "ProjectionThreadMessagesDispatchOrigin", Migration0049],
  [50, "ProfileStatsArchive", Migration0050],
  [51, "ProfileStatsDeletedTokensModel", Migration0051],
  [52, "ProjectionThreadUserMessageSummaryIndex", Migration0052],
  [53, "BackfillThreadActivitySequence", Migration0053],
  // Private development builds briefly recorded this tracker identity while
  // exercising provider delivery. Keep the ID/name canonical as a no-op; the
  // production cutover is registered independently at migration 64.
  [54, "DurableProviderCommandDelivery", Migration0054],
  [55, "ManagedAttachments", Migration0055],
  [56, "CommandReceiptFingerprints", Migration0056],
  [57, "ThreadScopedProjectionMessageIdentity", Migration0057],
  [58, "ThreadScopedPendingApprovalIdentity", Migration0058],
  [59, "ProviderSessionLifecycleGeneration", Migration0059],
  [60, "PendingApprovalLifecycleGeneration", Migration0060],
  [61, "PendingApprovalSettlementState", Migration0061],
  [62, "PendingInteractionSettlementParity", Migration0062],
  [63, "ProjectionMessageCausalSequence", Migration0063],
  [64, "DurableProviderCommandDeliveryCutover", Migration0064],
  [65, "DurableQueuedTurnPromotions", Migration0065],
  [66, "DurableProviderRuntimeEvents", Migration0066],
  [67, "ProviderDeliveryReconciliation", Migration0067],
  [68, "GitHandoffOperations", Migration0068],
  [69, "ProjectPullRequestPins", Migration0069],
  [70, "AgentGatewayOperations", Migration0070],
  [71, "ProjectionThreadsGatewayProvenance", Migration0071],
  [72, "AgentGatewayOperationRetention", Migration0072],
  [73, "OperationalDiagnostics", Migration0073],
  [79, "Spaces", Migration0079],
  [80, "PruneRejectedProductSurfaces", Migration0080],
  [86, "NormalizeStudioThreadWorkspaces", Migration0086],
  [87, "DropUnusedOrchestrationEventIndexes", Migration0087],
  [88, "ProjectionThreadsSpaces", Migration0088],
  [89, "ProjectionSpacesArchive", Migration0089],
  [90, "ThreadScopedProviderRuntimeProjection", Migration0090],
  [91, "SpaceNavigationState", Migration0091],
  [92, "RemoveProjectionThreadWorktreePath", Migration0092],
  [93, "VirtualFolders", Migration0093],
  [94, "RequireSpaces", Migration0094],
  [95, "SidebarManualOrdering", Migration0095],
  [96, "RemoveSidechatAndProviderHandoff", Migration0096],
  [97, "RenameGitThreadEnvironmentOperations", Migration0097],
  [98, "ProviderConnectionsAndBindings", Migration0098],
  [99, "ProviderThreadSwitchOperations", Migration0099],
  [100, "ReconcileProviderConnectionSchema", Migration0100],
  [101, "ExactProviderNativeStateMigration", Migration0101],
  [102, "ProviderConnectionLogins", Migration0102],
  [103, "DefaultNewSpacesAndConnections", Migration0103],
  [104, "ProviderNativeStateOwnership", Migration0104],
  [105, "ProviderNativeForkOperations", Migration0105],
  [106, "RemovePlanMode", Migration0106],
  [107, "ReconcileUnavailableSpaceConnectionDefaults", Migration0107],
  [108, "RemoveLegacyClaudeSetupTokenConnections", Migration0108],
  [109, "ProviderRuntimeBindingSwitchOperations", Migration0109],
  [110, "SettleProviderSwitchSource", Migration0110],
  [111, "DerivedProviderConnectionLabels", Migration0111],
] as const;

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Highest migration ID whose content is identical across every supported
 * imported lineage. A name mismatch at or below this ID
 * means the database does not come from any known lineage, so re-running
 * migrations could destroy data — refuse to start instead.
 */
export const LAST_SHARED_LINEAGE_MIGRATION_ID = 16;
const LATEST_MIGRATION_ID = Math.max(...migrationEntries.map(([id]) => id));

const canonicalMigrationNamesById: ReadonlyMap<number, string> = new Map(
  migrationEntries.map(([id, name]) => [id, name] as const),
);

/**
 * Finds the first canonical Penkra migration whose tracker identity differs.
 * Migration backup planning and runtime reconciliation share this predicate so
 * they cannot disagree about whether a database will be replayed.
 */
export const findFirstMigrationLineageDivergence = (
  recordedNamesById: ReadonlyMap<number, string>,
  highWaterMark: number,
) =>
  migrationEntries.find(([id, name]) => id <= highWaterMark && recordedNamesById.get(id) !== name);

export interface MigrationLineageAlias {
  readonly historicalId: number;
  readonly historicalName: string;
  readonly currentId: number;
  readonly historicalSlotRequiresRerun: boolean;
}

/**
 * Released tracker identities that moved to a new canonical ID.
 *
 * v0.5.5 recorded ProjectPullRequestPins at 54. The canonical migration now
 * lives at 69 while 54 is a no-op reservation, so the old tracker row can be
 * renamed in place without replaying already-applied schema.
 */
export const MIGRATION_LINEAGE_ALIASES: readonly MigrationLineageAlias[] = [
  {
    historicalId: 54,
    historicalName: "ProjectPullRequestPins",
    currentId: 69,
    historicalSlotRequiresRerun: false,
  },
];

export type MigrationLineageAliasRepair =
  | { readonly kind: "rename"; readonly migrationId: number; readonly name: string }
  | { readonly kind: "remove"; readonly migrationId: number };

export const planMigrationLineageAliasRepairs = (
  recordedNamesById: ReadonlyMap<number, string>,
): readonly MigrationLineageAliasRepair[] => {
  const applicable = MIGRATION_LINEAGE_ALIASES.filter(
    (alias) =>
      recordedNamesById.get(alias.historicalId) === alias.historicalName &&
      canonicalMigrationNamesById.get(alias.historicalId) !== alias.historicalName &&
      canonicalMigrationNamesById.get(alias.currentId) === alias.historicalName,
  );
  if (applicable.length === 0) return [];

  const repaired = new Map(recordedNamesById);
  const repairs: MigrationLineageAliasRepair[] = [];
  for (const alias of applicable) {
    const canonicalName = canonicalMigrationNamesById.get(alias.historicalId);
    if (alias.historicalSlotRequiresRerun || canonicalName === undefined) {
      repaired.delete(alias.historicalId);
      repairs.push({ kind: "remove", migrationId: alias.historicalId });
      continue;
    }
    repaired.set(alias.historicalId, canonicalName);
    repairs.push({ kind: "rename", migrationId: alias.historicalId, name: canonicalName });
  }

  const highWaterMark = Math.max(...repaired.keys(), 0);
  return findFirstMigrationLineageDivergence(repaired, highWaterMark) === undefined ? repairs : [];
};

/**
 * Repairs the migration tracker of an imported legacy database before the
 * migrator runs.
 *
 * Imported databases can carry their own `effect_sql_migrations` rows,
 * recorded under that lineage's migration names
 * at the same numeric IDs. The migrator gates purely on max(migration_id), so
 * once the imported tracker's high-water mark reaches Penkra's latest ID,
 * every Penkra migration is skipped silently and startup crashes on missing
 * columns such as `projection_threads.env_mode`. Renumbering self-heal
 * migrations past the legacy IDs (#023, then #032) loses that race whenever
 * the legacy lineage ships more migrations.
 *
 * Instead, compare the recorded (id, name) pairs against Penkra's lineage and
 * delete every tracker row from the first divergence onward. The migrator
 * then re-runs those migrations in order; every migration past
 * {@link LAST_SHARED_LINEAGE_MIGRATION_ID} is idempotent, so re-running them
 * over a legacy-evolved schema is safe and loses no data.
 */
export const reconcileMigrationLineage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The tracker table (Migrator's default name) does not exist before the
  // first migration run on a fresh database.
  const trackerTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (trackerTables.length === 0) {
    return;
  }

  let recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `;
  const recordedNamesBeforeCanonicalization = new Map(
    recorded.map((row) => [row.migration_id, row.name]),
  );
  const hasCanonicalPrefixThrough31 = migrationEntries
    .filter(([id]) => id < 32)
    .every(([id, name]) => recordedNamesBeforeCanonicalization.get(id) === name);
  const migration32Name = recordedNamesBeforeCanonicalization.get(32);
  if (
    hasCanonicalPrefixThrough31 &&
    migration32Name !== undefined &&
    migration32Name !== "ReconcileImportedSchemaLineage"
  ) {
    yield* sql`
      UPDATE effect_sql_migrations
      SET name = 'ReconcileImportedSchemaLineage'
      WHERE migration_id = 32
    `;
    recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
    `;
  }

  const aliasRepairs = planMigrationLineageAliasRepairs(
    new Map(recorded.map((row) => [row.migration_id, row.name])),
  );
  if (aliasRepairs.length > 0) {
    yield* Effect.logInfo(
      "Migration tracker records a renumbered Penkra migration; repairing tracker metadata in place",
    ).pipe(
      Effect.annotateLogs({
        repairs: aliasRepairs.map((repair) =>
          repair.kind === "rename"
            ? `rename ${repair.migrationId} -> ${repair.name}`
            : `remove ${repair.migrationId}`,
        ),
      }),
    );
    yield* Effect.forEach(
      aliasRepairs,
      (repair) =>
        repair.kind === "rename"
          ? sql`
              UPDATE effect_sql_migrations
              SET name = ${repair.name}
              WHERE migration_id = ${repair.migrationId}
            `
          : sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${repair.migrationId}`,
      { discard: true },
    );
    recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
    `;
  }

  const highWaterMark = recorded[recorded.length - 1]?.migration_id;
  if (highWaterMark === undefined) {
    return;
  }

  const recordedNamesById = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const diverged = findFirstMigrationLineageDivergence(recordedNamesById, highWaterMark);
  if (diverged === undefined) {
    // An exact known prefix followed by unknown migrations is a database from
    // a newer Penkra build. Continuing would expose it to stale writable
    // repositories and background services, so fail before the migrator can
    // mutate either schema or tracker state.
    if (highWaterMark > LATEST_MIGRATION_ID) {
      return yield* Effect.fail(
        new MigrationSchemaTooNewError({
          databaseMigrationId: highWaterMark,
          latestSupportedMigrationId: LATEST_MIGRATION_ID,
        }),
      );
    }
    return;
  }

  const [firstDivergedId, expectedName] = diverged;
  const recordedName = recordedNamesById.get(firstDivergedId) ?? "<missing>";
  if (firstDivergedId <= LAST_SHARED_LINEAGE_MIGRATION_ID) {
    return yield* Effect.fail(
      new MigrationLineageError({ firstDivergedId, expectedName, recordedName }),
    );
  }

  yield* Effect.logWarning(
    "Migration tracker diverges from the Penkra lineage (legacy import); re-running migrations from the divergence point",
  ).pipe(Effect.annotateLogs({ firstDivergedId, expectedName, recordedName, highWaterMark }));

  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${firstDivergedId}`;
});

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = ({ toMigrationInclusive }: RunMigrationsOptions = {}) =>
  Effect.gen(function* () {
    yield* reconcileMigrationLineage;
    yield* Effect.log(
      toMigrationInclusive === undefined
        ? "Running all migrations..."
        : `Running migrations 1 through ${toMigrationInclusive}...`,
    );
    const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
    yield* Effect.log("Migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
    );
    return executedMigrations;
  });

/**
 * Layer that runs migrations when the layer is built.
 *
 * Use this to ensure migrations run before your application starts.
 * Migrations are run automatically - no separate script is needed.
 *
 * @example
 * ```typescript
 * import { MigrationsLive } from "@acme/db/Migrations"
 * import * as SqliteClient from "@acme/db/SqliteClient"
 *
 * // Migrations run automatically when SqliteClient is provided
 * const AppLayer = MigrationsLive.pipe(
 *   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
 * )
 * ```
 */
export const MigrationsLive = Layer.effectDiscard(runMigrations());
