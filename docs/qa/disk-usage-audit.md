# Production disk ownership observations, 2026-10-22

This records read-only measurements and source inspection. No Production files
were deleted, moved, copied, or opened as SQLite databases. The registered local
`/status` endpoint reported version `0.14.4` and migration status `ok` (backend
PID 8023). These measurements are not an atomic snapshot: Production was live.

## Allocated storage

One `du -sk` invocation measured the roots below together, with profiles before
native state, so shared hard-linked files contribute once rather than to both.
Values are allocated KiB, not logical file sizes or independently additive
measurements from separate scans.

| Root below `~/Penkra/.penkra/userdata` | Allocated KiB | Directory count |
| -------------------------------------- | ------------: | --------------: |
| provider-connections                   |    53,596,580 |              13 |
| provider-native-state                  |    31,205,588 |             524 |
| thread-workspaces                      |    20,590,292 |             253 |
| provider-runtimes                      |    15,757,972 |     65 versions |
| attachments                            |       502,000 |     not counted |
| logs                                   |       450,416 |     not counted |
| tool-results                           |        88,016 |     not counted |

Runtime version counts: Claude 26, Codex 25, OpenCode 11, Pi 3. The backup
directory's allocated total was zero at this observation. The current database
file's filesystem logical size was 3,659,689,984 bytes; its contents were not
inspected. Available filesystem capacity was approximately 92 GiB.

Across the two Connection-profile Codex session trees, 448 rollout files occupy
26,650,517,504 allocated bytes. Of these, 152 have a single hard link and occupy
2,605,297,664 allocated bytes. A single link is not proof of an orphan: it says
only that no second hard link currently adopts that inode. No rollout is marked
safe to delete from this measurement.

## Source ownership findings

| Data                       | Writer / owner                                                                  | Current deletion behavior inspected                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime installations      | `managedProviderArtifactInstaller`, activated by `ensurePinnedProviderRuntimes` | Startup installation/activation does not prune all versions except current/previous. The activation record already distinguishes active and previous.                                                               |
| Durable thread workspace   | `ensureDurableThreadWorkspace` in `scratchWorkspaces.ts`                        | The canonical `ThreadLifecycle` delete path does not remove this directory. Its current native-state deletion is not workspace deletion.                                                                            |
| Native thread directory    | `ProviderLaunchResolver`, `ProviderNativeStateMaterializer`                     | Canonical thread deletion removes the exact `native_state_id` directory before marking the row deleted. Retention uses that same lifecycle path.                                                                    |
| Connection Codex rollout   | Native Codex, then `adoptManagedCodexRollout` hard-link adoption                | Removing the thread directory does not remove its remaining profile link.                                                                                                                                           |
| Penkra spilled tool result | `storeToolResult` in `packages/shared/src/toolResults.ts`                       | Files are grouped by thread ID. Canonical thread deletion does not remove that group.                                                                                                                               |
| Managed attachment         | Managed attachment store/repository                                             | A repository operation `markCleanupByThread` exists, but its inspected production call sites do not wire it into canonical thread deletion. The cleanup service separately handles jobs already marked for cleanup. |
| Provider caches            | Connection environment from `providerConnectionManifests.ts`                    | Each profile receives its own `xdg-cache`. Credential-free eligibility for a shared cache has not been established by this inspection.                                                                              |
| Migration backup           | `MigrationBackup.ts`                                                            | Existing source already sets `MIGRATION_BACKUP_RETENTION = 1` and calls the prune path. This cannot be described as having no retention. Release-scoped policy still needs comparison to the approved requirement.  |

## Evidence limits

No complete live-plus-archived thread/native-session ownership inventory was
obtained from a registered API in this observation. Consequently this document
does not certify any directory, rollout, workspace, or runtime version as an
orphan, and contains no approved deletion list. Cache credential safety has not
been established. Those limitations prevent treating the storage measurements
as a completed P27 deletion audit or implementing destructive cleanup from them.

The pinned OpenCode contract independently proves that native export/import
preserves absolute source paths for spilled tool-output files without copying
their contents. See `provider-runtime-inventory.md`, section 15. Removing an old
native directory after import therefore requires a defined preservation rule;
successful JSON import alone is not evidence that every referenced file moved.
