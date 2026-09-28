# Diagnostics failure inventory — source snapshot

Read-only source and production-log inventory from the `design/diagnostics-0.14.2` branch at
`cbd0567ee`. The site counts and line numbers are a snapshot of that branch, not a current-branch
coverage result. Re-run and review the inventory against the implementation branch before using
it as a release gate. This is an inventory of control-flow sites, not a claim that each path
executes in production. No application code or production state was changed by this scan.

## Method and interpretation

- Scope: 1,539 non-test JavaScript/TypeScript files in `apps/server/src`, `apps/web/src`, and `apps/desktop/src`. Each matching operation is one site; multiple operations on one line are separate rows.
- Included: Effect failure, defect, timeout, handler, fallback, retry, ignore, tapError and warning/error calls; every `try` and `catch` block and Promise `.catch`; semantic decision branches for retry, fallback, quarantine, refusal, rejection, failure and timeout; promise rejection and throw sites; console warning/error; and socket/RPC rejection hooks and calls. `try` rows identify the protected operation; `catch` rows identify the local handling decision. A `try` row is a boundary, not necessarily an additional incident. Keyword-only comments and tests are excluded. The WebSocket/RPC column is limited to transport files or explicit socket/RPC context.
- Flow uses the design flow map. `(new)` identifies a flow added beyond the design map. The Windows rows were reviewed by source module and local operation; `main.ts` uses the operation and surrounding source, since it hosts many flows. Classification remains a proposed assignment; inspect the cited site before implementing an incident.
- Surface describes the local operation. `SILENT` is a conservative local scan result: no log, throw, returned error, or UI signal was apparent in the local handler window. A downstream handler may still surface it. IDs are counted only when `threadId`, `turnId`, `commandId`, or `connectionId` is explicit in the local call; ambient context and upstream spans are not assumed. `none` therefore means **no locally visible trace ID**, not proof that the whole call chain lacks one.
- Proposed codes are starting names. Generic `*_CAUGHT_ERROR`, `*_FAILED`, and `*_FALLBACK` codes need a more specific reviewed code when instrumented. Do not derive a permanent code from user content.

## Summary

**5,327 sites**; **446 SILENT**; **4,923 without a locally visible thread/turn/command/connection ID**. The full site table is in [diagnostics-failure-sites.md](diagnostics-failure-sites.md).

**Windows reclassification:** 1,775 before → 215 after; 1560 rows moved to their actual feature or lifecycle flow. The original classifier treated most desktop and renderer components as Windows by default. The revised assignment uses source module, operation, and local source context; the total site count is unchanged.

### By flow

| Flow                      | Sites | SILENT | No local trace ID |
| ------------------------- | ----: | -----: | ----------------: |
| Apps / extensions         |  1172 |     48 |              1166 |
| Provider delivery         |   723 |     73 |               603 |
| Socket connect            |   423 |     20 |               404 |
| Files and workspace (new) |   380 |     12 |               380 |
| Command worker            |   342 |     20 |               235 |
| Database                  |   267 |     27 |               267 |
| Simulator (new)           |   266 |      5 |               266 |
| Windows                   |   215 |     45 |               183 |
| Send                      |   199 |     24 |               177 |
| Agent / MCP writes        |   166 |     25 |               136 |
| Web utilities (new)       |   162 |     17 |               150 |
| Boot / shutdown           |   160 |     19 |               160 |
| App update                |   159 |      9 |               159 |
| Sign-in / token refresh   |   108 |      4 |               106 |
| Terminal (new)            |   105 |     22 |                80 |
| Settings (new)            |   102 |     20 |               101 |
| Server utilities (new)    |    73 |     16 |                72 |
| Voice (new)               |    67 |      1 |                67 |
| Provider usage (new)      |    43 |      6 |                43 |
| HTTP API (new)            |    33 |     17 |                33 |
| Process launch (new)      |    31 |      3 |                31 |
| Text generation (new)     |    31 |      6 |                31 |
| Diagnostics (new)         |    26 |      0 |                26 |
| Archive                   |    25 |      5 |                 8 |
| Thread create             |    18 |      2 |                14 |
| Turn reconciliation       |    13 |      0 |                 8 |
| Desktop lifecycle (new)   |     9 |      0 |                 8 |
| External navigation (new) |     7 |      0 |                 7 |
| Play / continue           |     1 |      0 |                 1 |
| Queue                     |     1 |      0 |                 1 |

### By surfacing

| Surface                  | Sites |
| ------------------------ | ----: |
| thrown                   |  1847 |
| handled by catch/finally |  1050 |
| SILENT                   |   446 |
| thrown/rejected          |   390 |
| returned/UI error        |   283 |
| returned decision        |   248 |
| returned failure         |   237 |
| warning log              |   171 |
| Effect.warn              |   156 |
| console                  |   136 |
| branch (see body)        |   123 |
| error log                |    68 |
| RPC/socket rejection     |    39 |
| rejected promise         |    29 |
| Effect.error             |    29 |
| defect                   |    29 |
| returned/thrown          |    28 |
| timeout result           |    18 |

## Top findings

Ranked by likely effect on durable progress, then frequency. This is a source-and-log priority order, **not a measured count of affected users or Threads**. Counts come from the read-only `server.log` scan below. “Unverified” means the cause or whether the volume is normal has not been established.

| Rank | Production message and count                                        | Emitting site                                                                                                                                              | Expected or fault?                                                                                                                                                                                                                   | Why it matters                                                                                                                                |
| ---: | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `provider runtime journal drain failed` — **2,275**                 | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:2741`                                                                                    | **Fault.** The drain catches a non-interruption cause and warns instead of completing the drain. All 2,275 records contain an SQL error; 737 explicitly contain `disk I/O error`. The causes of the other SQL errors are unverified. | The runtime journal cannot progress through that drain attempt; the retry scheduler is the recovery path.                                     |
|    2 | `provider.runtime_event_pump.quarantined_event` — **2,264**         | `apps/server/src/provider/providerRuntimeEventPump.ts:236`                                                                                                 | **Fault recorded through an intentional quarantine path.** All 2,264 records contain a decode error. The invalid event shape and upstream cause are unverified.                                                                      | A permanent event-processing failure is quarantined, then provider health is marked degraded.                                                 |
|    3 | `orchestration lifecycle command rejected` — **28,997**             | Historical emitter: `apps/server/src/wsRpc.ts:751` at `c74915098^`; current equivalent: `apps/server/src/wsRpc.ts:860` (`orchestration command rejected`). | **Expected guard, repeated cause unverified.** 28,986 records reject `thread.turn.start` because changing a thread selection lacked its exact binding revision. Why the caller submitted these commands is unverified.               | The command is refused before the requested turn starts; the volume suggests a repeated caller or stale selection state worth tracing.        |
|    4 | `stale orchestration synchronization acknowledgement` — **155,108** | `apps/server/src/wsSyncAcknowledgements.ts:83`                                                                                                             | **Unverified operational status.** The rejection is deliberate when the lease is missing, the delivery ID differs, or no sequence was delivered. Whether these are expected reconnect races or a fault is unverified.                | It is 47% of the scanned log records and obscures rarer failures; current warning records client and delivery IDs but not which check failed. |
|    5 | `Rejected streaming RPC admission.` — **6,233**                     | `apps/server/src/wsStreamAdmission.ts:142`                                                                                                                 | **Expected capacity/duplicate guard; cause of repetition unverified.** The log has 6,053 duplicate and 180 historical thread-capacity reasons. The current branch emits duplicate and stream-capacity reasons.                       | Subscriptions are refused and may retry; the repeated duplicate pattern needs connection and lease trace evidence.                            |

## Named numeric limits

The following numeric assignments/call sites have timeout, cap, retry, budget, interval, delay, TTL or limit names. Values are source expressions; units follow the identifier or API and should be registered explicitly in `limits.ts`. Dynamic values and numbers without a limit name need a separate semantic review.

| Limit                                                      |     Value in source | Location                                                                                |
| ---------------------------------------------------------- | ------------------: | --------------------------------------------------------------------------------------- |
| `AUTH_CALLBACK_TIMEOUT_MS`                                 |            `20_000` | `apps/desktop/src/accountAuth.ts:26`                                                    |
| `DEFAULT_SWIPE_DURATION_MS`                                |               `300` | `apps/desktop/src/androidEmulatorController.ts:17`                                      |
| `SWIPE_FRAME_MS`                                           |                `16` | `apps/desktop/src/androidEmulatorController.ts:18`                                      |
| `timeoutMs@197`                                            |            `10_000` | `apps/desktop/src/androidEmulatorController.ts:197`                                     |
| `timeoutMs@215`                                            |            `10_000` | `apps/desktop/src/androidEmulatorController.ts:215`                                     |
| `timeoutMs@230`                                            |            `10_000` | `apps/desktop/src/androidEmulatorController.ts:230`                                     |
| `START_TIMEOUT_MS`                                         |          `3*60_000` | `apps/desktop/src/androidEmulatorLauncher.ts:19`                                        |
| `ENDPOINT_POLL_MS`                                         |               `100` | `apps/desktop/src/androidEmulatorLauncher.ts:20`                                        |
| `MAX_DIAGNOSTIC_BYTES`                                     |          `256*1024` | `apps/desktop/src/androidEmulatorLauncher.ts:21`                                        |
| `timeoutMs@272`                                            |            `10_000` | `apps/desktop/src/androidEmulatorLauncher.ts:272`                                       |
| `timeoutMs@312`                                            |             `5_000` | `apps/desktop/src/androidEmulatorLauncher.ts:312`                                       |
| `MAX_OUTPUT_BYTES`                                         |      `16*1024*1024` | `apps/desktop/src/androidSdkLicenseReviewer.ts:9`                                       |
| `timeoutMs@127`                                            |          `3*60_000` | `apps/desktop/src/androidSimulatorAdapter.ts:127`                                       |
| `MAX_REQUEST_BYTES`                                        |      `24*1024*1024` | `apps/desktop/src/appAccountData.ts:10`                                                 |
| `MAX_RESPONSE_BYTES`                                       |      `24*1024*1024` | `apps/desktop/src/appAccountData.ts:11`                                                 |
| `CONNECT_TIMEOUT_MS`                                       |            `10_000` | `apps/desktop/src/appAccountData.ts:12`                                                 |
| `timeout@67`                                               |            `30_000` | `apps/desktop/src/appAccountData.ts:67`                                                 |
| `timeout@17`                                               |            `15_000` | `apps/desktop/src/appAccountProfile.ts:17`                                              |
| `MAX_REQUEST_BYTES`                                        |         `1024*1024` | `apps/desktop/src/appCommandPipeServer.ts:30`                                           |
| `APP_COMMAND_MAX_RESPONSE_BYTES`                           |      `32*1024*1024` | `apps/desktop/src/appCommandPipeServer.ts:31`                                           |
| `MAX_ITEMS`                                                |               `500` | `apps/desktop/src/appContextMenu.ts:24`                                                 |
| `MAX_STATE_BYTES`                                          |       `4*1024*1024` | `apps/desktop/src/appDataVault.ts:10`                                                   |
| `APP_ICON_MAX_BYTES`                                       |          `256*1024` | `apps/desktop/src/appIconDataUrl.ts:10`                                                 |
| `timeout@40`                                               |            `15_000` | `apps/desktop/src/appIdentityToken.ts:40`                                               |
| `APP_INSTALLATION_STATE_MAX_BYTES`                         |       `4*1024*1024` | `apps/desktop/src/appInstallationStore.ts:17`                                           |
| `MAX_BODY_BYTES`                                           |      `10*1024*1024` | `apps/desktop/src/appNetworkFetch.ts:10`                                                |
| `MAX_BYTES`                                                |         `1024*1024` | `apps/desktop/src/appOpenWithPreferences.ts:16`                                         |
| `APP_OPERATION_VALUE_MAX_BYTES`                            |         `1024*1024` | `apps/desktop/src/appOperationSchema.ts:13`                                             |
| `APP_OPERATION_VALUE_MAX_DEPTH`                            |                `64` | `apps/desktop/src/appOperationSchema.ts:14`                                             |
| `APP_OPERATION_VALUE_MAX_NODES`                            |           `100_000` | `apps/desktop/src/appOperationSchema.ts:15`                                             |
| `timeout@127`                                              |            `15_000` | `apps/desktop/src/appRegistryClient.ts:127`                                             |
| `timeout@234`                                              |            `15_000` | `apps/desktop/src/appRegistryClient.ts:234`                                             |
| `timeout@662`                                              |            `15_000` | `apps/desktop/src/appRegistryClient.ts:662`                                             |
| `timeout@711`                                              |            `60_000` | `apps/desktop/src/appRegistryClient.ts:711`                                             |
| `timeout@765`                                              |            `30_000` | `apps/desktop/src/appRegistryClient.ts:765`                                             |
| `timeout@788`                                              |            `15_000` | `apps/desktop/src/appRegistryClient.ts:788`                                             |
| `REGISTRY_PACKAGE_DOWNLOAD_STALL_TIMEOUT_MS`               |            `30_000` | `apps/desktop/src/appRegistryPackageDownload.ts:10`                                     |
| `DEFAULT_MAX_PAYLOAD_BYTES`                                |         `1024*1024` | `apps/desktop/src/appRendererRpc.ts:140`                                                |
| `DEFAULT_MAX_RESULT_PAYLOAD_BYTES`                         |      `24*1024*1024` | `apps/desktop/src/appRendererRpc.ts:141`                                                |
| `DEFAULT_MAX_PENDING_PER_TARGET`                           |               `128` | `apps/desktop/src/appRendererRpc.ts:142`                                                |
| `DEFAULT_TIMEOUT_MS`                                       |           `120_000` | `apps/desktop/src/appRendererRpc.ts:143`                                                |
| `APP_RUNTIME_DIAGNOSTICS_MAX_BYTES`                        |       `2*1024*1024` | `apps/desktop/src/appRuntimeDiagnostics.ts:10`                                          |
| `APP_RUNTIME_DIAGNOSTICS_MAX_LIST_LIMIT`                   |             `2_000` | `apps/desktop/src/appRuntimeDiagnostics.ts:11`                                          |
| `APP_FILE_WRITE_CHUNK_BYTES`                               |         `1024*1024` | `apps/desktop/src/appScopedFileWriteStore.ts:9`                                         |
| `APP_FILE_WRITE_MAX_BYTES`                                 |      `64*1024*1024` | `apps/desktop/src/appScopedFileWriteStore.ts:10`                                        |
| `WRITE_FILE_MAX_BYTES`                                     |         `1024*1024` | `apps/desktop/src/appStorage.ts:10`                                                     |
| `DEFAULT_MIN_FREE_BYTES`                                   |     `512*1024*1024` | `apps/desktop/src/appStorage.ts:11`                                                     |
| `COMPOSER_ATTACHMENT_MAX_BYTES`                            |     `256*1024*1024` | `apps/desktop/src/appStorage.ts:12`                                                     |
| `MAX_INLINE_SCREENSHOT_BYTES`                              |      `12*1024*1024` | `apps/desktop/src/appTabObserver.ts:22`                                                 |
| `MAX_WAIT_MS`                                              |            `25_000` | `apps/desktop/src/appTabObserver.ts:23`                                                 |
| `APP_TEST_PHASE_TIMEOUT_MS`                                |            `10_000` | `apps/desktop/src/appTestHostPhases.ts:5`                                               |
| `MAX_RESPONSE_BODY_BYTES`                                  |         `1024*1024` | `apps/desktop/src/appTransfer.ts:23`                                                    |
| `TICKET_LIFETIME_MS`                                       |          `5*60_000` | `apps/desktop/src/appTransfer.ts:24`                                                    |
| `APP_UPDATE_JOURNAL_MAX_BYTES`                             |       `5*1024*1024` | `apps/desktop/src/appUpdateJournal.ts:14`                                               |
| `APPIUM_SESSION_START_TIMEOUT_MS`                          |         `10*60_000` | `apps/desktop/src/appleAppiumAutomation.ts:14`                                          |
| `APPIUM_SESSION_DELETE_TIMEOUT_MS`                         |             `5_000` | `apps/desktop/src/appleAppiumAutomation.ts:15`                                          |
| `APPIUM_START_TIMEOUT_MS`                                  |            `30_000` | `apps/desktop/src/appleAppiumServer.ts:9`                                               |
| `APPIUM_STOP_TIMEOUT_MS`                                   |             `5_000` | `apps/desktop/src/appleAppiumServer.ts:10`                                              |
| `timeout@93`                                               |             `1_000` | `apps/desktop/src/appleAppiumServer.ts:93`                                              |
| `timeoutMs@224`                                            |             `5_000` | `apps/desktop/src/appleSimulatorAdapter.ts:224`                                         |
| `timeoutMs@234`                                            |            `30_000` | `apps/desktop/src/appleSimulatorAdapter.ts:234`                                         |
| `timeoutMs@238`                                            |           `120_000` | `apps/desktop/src/appleSimulatorAdapter.ts:238`                                         |
| `DEFAULT_TIMEOUT_MS`                                       |            `30_000` | `apps/desktop/src/backendReadiness.ts:16`                                               |
| `DEFAULT_INTERVAL_MS`                                      |               `100` | `apps/desktop/src/backendReadiness.ts:17`                                               |
| `DEFAULT_REQUEST_TIMEOUT_MS`                               |             `1_000` | `apps/desktop/src/backendReadiness.ts:18`                                               |
| `BACKEND_RESTART_BASE_DELAY_MS`                            |               `500` | `apps/desktop/src/backendSupervisionPolicy.ts:8`                                        |
| `BACKEND_RESTART_MAX_DELAY_MS`                             |            `10_000` | `apps/desktop/src/backendSupervisionPolicy.ts:9`                                        |
| `BACKEND_MAX_CONSECUTIVE_START_FAILURES`                   |                 `5` | `apps/desktop/src/backendSupervisionPolicy.ts:22`                                       |
| `BACKEND_FAILURE_SUMMARY_MAX_LINES`                        |                 `8` | `apps/desktop/src/backendSupervisionPolicy.ts:26`                                       |
| `MAX_SNAPSHOT_BYTES`                                       |      `32*1024*1024` | `apps/desktop/src/composerDraftJournal.ts:17`                                           |
| `MAX_ASSET_BYTES`                                          |     `256*1024*1024` | `apps/desktop/src/composerDraftJournal.ts:18`                                           |
| `RECOVERY_OUTPUT_LIMIT_BYTES`                              |           `64*1024` | `apps/desktop/src/desktopMigrationRecovery.ts:15`                                       |
| `PENKRA_STORAGE_SNAPSHOT_MAX_BYTES`                        |      `16*1024*1024` | `apps/desktop/src/desktopStorageMigration.ts:11`                                        |
| `PENKRA_STORAGE_SNAPSHOT_MAX_ENTRIES`                      |             `2_048` | `apps/desktop/src/desktopStorageMigration.ts:12`                                        |
| `PENKRA_STORAGE_SNAPSHOT_MAX_KEY_LENGTH`                   |               `512` | `apps/desktop/src/desktopStorageMigration.ts:13`                                        |
| `PENKRA_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH`                 |      `16*1024*1024` | `apps/desktop/src/desktopStorageMigration.ts:14`                                        |
| `timeout@16`                                               |            `30_000` | `apps/desktop/src/desktopThreadClient.ts:16`                                            |
| `COMMAND_TIMEOUT_MS`                                       |             `2_000` | `apps/desktop/src/macUpdateDiagnostics.ts:12`                                           |
| `MAX_DIAGNOSTIC_BYTES`                                     |            `8*1024` | `apps/desktop/src/macUpdateDiagnostics.ts:13`                                           |
| `MAX_COMMAND_BUFFER_BYTES`                                 |           `64*1024` | `apps/desktop/src/macUpdateDiagnostics.ts:14`                                           |
| `LOG_FILE_MAX_BYTES`                                       |      `10*1024*1024` | `apps/desktop/src/main.ts:420`                                                          |
| `LOG_FILE_MAX_FILES`                                       |                `10` | `apps/desktop/src/main.ts:421`                                                          |
| `AUTO_UPDATE_STARTUP_DELAY_MS`                             |            `15_000` | `apps/desktop/src/main.ts:448`                                                          |
| `AUTO_UPDATE_POLL_INTERVAL_MS`                             |      `4*60*60*1000` | `apps/desktop/src/main.ts:449`                                                          |
| `AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS`           |         `5*60*1000` | `apps/desktop/src/main.ts:450`                                                          |
| `AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS`         |           `30*1000` | `apps/desktop/src/main.ts:451`                                                          |
| `AUTO_UPDATE_CHECK_TIMEOUT_MS`                             |           `45*1000` | `apps/desktop/src/main.ts:452`                                                          |
| `AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS`                    |           `60*1000` | `apps/desktop/src/main.ts:453`                                                          |
| `AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS`                   |           `20*1000` | `apps/desktop/src/main.ts:456`                                                          |
| `AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS` |         `2*60*1000` | `apps/desktop/src/main.ts:457`                                                          |
| `AUTO_UPDATE_INSTALL_WATCHDOG_MS`                          |           `15*1000` | `apps/desktop/src/main.ts:461`                                                          |
| `AUTO_UPDATE_DIAGNOSTICS_TIMEOUT_MS`                       |             `2_800` | `apps/desktop/src/main.ts:462`                                                          |
| `BACKEND_FORCE_KILL_DELAY_MS`                              |             `8_000` | `apps/desktop/src/main.ts:467`                                                          |
| `BACKEND_SHUTDOWN_TIMEOUT_MS`                              |            `10_000` | `apps/desktop/src/main.ts:468`                                                          |
| `UPDATE_BACKEND_FORCE_KILL_DELAY_MS`                       |           `125_000` | `apps/desktop/src/main.ts:472`                                                          |
| `UPDATE_BACKEND_SHUTDOWN_TIMEOUT_MS`                       |           `130_000` | `apps/desktop/src/main.ts:473`                                                          |
| `DESKTOP_MENU_MIN_ZOOM_FACTOR`                             |                 `0` | `apps/desktop/src/main.ts:477`                                                          |
| `DESKTOP_MENU_MAX_ZOOM_FACTOR`                             |                 `5` | `apps/desktop/src/main.ts:478`                                                          |
| `AUTOMATIC_APP_UPDATE_INTERVAL_MS`                         |     `6*60*60*1_000` | `apps/desktop/src/main.ts:480`                                                          |
| `AUTOMATIC_APP_UPDATE_FAILURE_RETRY_MS`                    |       `15*60*1_000` | `apps/desktop/src/main.ts:481`                                                          |
| `MAX_PENDING_APP_TAB_EVENTS`                               |               `128` | `apps/desktop/src/main.ts:488`                                                          |
| `timeoutMs@2039`                                           |            `60_000` | `apps/desktop/src/main.ts:2039`                                                         |
| `BUNDLE_SWAP_POLL_INTERVAL_MS`                             |            `15_000` | `apps/desktop/src/main.ts:3363`                                                         |
| `MAX_STATE_BYTES`                                          |       `4*1024*1024` | `apps/desktop/src/providerCredentialVault.ts:9`                                         |
| `MAX_SECRET_BYTES`                                         |           `64*1024` | `apps/desktop/src/providerCredentialVault.ts:10`                                        |
| `DEFAULT_LEASE_TTL_MS`                                     |            `30_000` | `apps/desktop/src/providerCredentialVault.ts:11`                                        |
| `RENDERER_RELOAD_BASE_DELAY_MS`                            |               `500` | `apps/desktop/src/rendererCrashRecovery.ts:8`                                           |
| `RENDERER_RELOAD_MAX_DELAY_MS`                             |             `4_000` | `apps/desktop/src/rendererCrashRecovery.ts:9`                                           |
| `RENDERER_MAX_AUTOMATIC_RELOADS`                           |                 `3` | `apps/desktop/src/rendererCrashRecovery.ts:19`                                          |
| `RENDERER_CRASH_STREAK_WINDOW_MS`                          |            `60_000` | `apps/desktop/src/rendererCrashRecovery.ts:27`                                          |
| `REQUIRED_APPS_LOCK_MAX_BYTES`                             |           `16*1024` | `apps/desktop/src/requiredRegistryAppBootstrap.ts:37`                                   |
| `idleTimeoutMs@32`                                         |            `15_000` | `apps/desktop/src/resumableUpdateDownloadPolicy.ts:32`                                  |
| `retryBaseDelayMs@33`                                      |               `500` | `apps/desktop/src/resumableUpdateDownloadPolicy.ts:33`                                  |
| `retryMaxDelayMs@34`                                       |             `5_000` | `apps/desktop/src/resumableUpdateDownloadPolicy.ts:34`                                  |
| `overallTimeoutMs@37`                                      |         `10*60_000` | `apps/desktop/src/resumableUpdateDownloadPolicy.ts:37`                                  |
| `DISCOVERY_CACHE_MS`                                       |             `5_000` | `apps/desktop/src/simulatorAdapterBundle.ts:34`                                         |
| `SIMULATOR_DEVICE_STATE_MAX_BYTES`                         |       `4*1024*1024` | `apps/desktop/src/simulatorDeviceStore.ts:12`                                           |
| `MAX_BUFFER_BYTES`                                         |      `20*1024*1024` | `apps/desktop/src/simulatorMjpegStream.ts:7`                                            |
| `DEFAULT_TIMEOUT_MS`                                       |            `30_000` | `apps/desktop/src/simulatorNativeCommand.ts:7`                                          |
| `DEFAULT_MAX_OUTPUT_BYTES`                                 |       `8*1024*1024` | `apps/desktop/src/simulatorNativeCommand.ts:8`                                          |
| `DISCOVERY_TIMEOUT_MS`                                     |            `15_000` | `apps/desktop/src/simulatorPlatformDiscovery.ts:20`                                     |
| `DISCOVERY_MAX_BUFFER_BYTES`                               |       `8*1024*1024` | `apps/desktop/src/simulatorPlatformDiscovery.ts:21`                                     |
| `MAX_OUTPUT_BYTES`                                         |      `16*1024*1024` | `apps/desktop/src/simulatorRuntimeInstaller.ts:7`                                       |
| `STOP_TIMEOUT_MS`                                          |             `5_000` | `apps/desktop/src/simulatorRuntimeInstaller.ts:8`                                       |
| `MAX_SPACES_MENU_ITEMS`                                    |               `100` | `apps/desktop/src/spacesMenu.ts:3`                                                      |
| `INSTALL_MARKER_STALE_AFTER_MS`                            |   `7*24*60*60*1000` | `apps/desktop/src/updateInstallMarker.ts:17`                                            |
| `MAX_HELPER_OUTPUT_BYTES`                                  |         `1024*1024` | `apps/desktop/src/voiceTranscription.ts:23`                                             |
| `CAPABILITY_TIMEOUT_MS`                                    |            `15_000` | `apps/desktop/src/voiceTranscription.ts:24`                                             |
| `TRANSCRIPTION_TIMEOUT_MS`                                 |          `5*60_000` | `apps/desktop/src/voiceTranscription.ts:25`                                             |
| `SERVER_TRANSCRIPTION_TIMEOUT_MS`                          |            `45_000` | `apps/desktop/src/voiceTranscription.ts:26`                                             |
| `TURN_INTERRUPT_CONFIRM_TIMEOUT_MS`                        |             `5_000` | `apps/server/src/agentGateway/Layers/AgentGateway.ts:112`                               |
| `TURN_INTERRUPT_CONFIRM_POLL_MS`                           |                `25` | `apps/server/src/agentGateway/Layers/AgentGateway.ts:113`                               |
| `MAX_ARRAY_ITEMS`                                          |                `50` | `apps/server/src/agentGateway/diagnosticSanitizer.ts:5`                                 |
| `AGENT_GATEWAY_MCP_MAX_BODY_BYTES`                         |         `1024*1024` | `apps/server/src/agentGateway/httpRoute.ts:20`                                          |
| `MCP_MAX_BATCH_MESSAGES`                                   |                `50` | `apps/server/src/agentGateway/mcpTransport.ts:30`                                       |
| `DEFAULT_PAGE_LIMIT`                                       |                `50` | `apps/server/src/agentGateway/threadDiagnosticSummary.ts:6`                             |
| `MAX_PAGE_LIMIT`                                           |               `200` | `apps/server/src/agentGateway/threadDiagnosticSummary.ts:7`                             |
| `DIAGNOSTIC_EVENT_SCAN_CHUNK_SIZE`                         |               `250` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:45`                              |
| `DIAGNOSTIC_EVENT_MAX_COALESCING_SCAN`                     |            `10_000` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:46`                              |
| `limit@430`                                                |                `20` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:430`                             |
| `limit@432`                                                |                `50` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:432`                             |
| `limit@438`                                                |                `50` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:438`                             |
| `limit@443`                                                |               `100` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:443`                             |
| `limit@448`                                                |               `100` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:448`                             |
| `messageLimit@504`                                         |                `20` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:504`                             |
| `globalCap@566`                                            |            `10_000` | `apps/server/src/agentGateway/threadDiagnosticTools.ts:566`                             |
| `LIST_THREADS_DEFAULT_LIMIT`                               |                `50` | `apps/server/src/agentGateway/threadReadTools.ts:53`                                    |
| `LIST_THREADS_MAX_PAGE_SIZE`                               |               `100` | `apps/server/src/agentGateway/threadReadTools.ts:54`                                    |
| `MODELS_RESPONSE_MAX_CHARS`                                |            `40_000` | `apps/server/src/agentGateway/threadReadTools.ts:55`                                    |
| `remainingBudget`                                          |            `20_000` | `apps/server/src/agentGateway/threadReadTools.ts:1177`                                  |
| `READ_THREAD_DEFAULT_MESSAGE_LIMIT`                        |                `20` | `apps/server/src/agentGateway/threadSummary.ts:126`                                     |
| `READ_THREAD_MAX_MESSAGE_LIMIT`                            |               `100` | `apps/server/src/agentGateway/threadSummary.ts:127`                                     |
| `READ_THREAD_MAX_MESSAGE_CHARS`                            |            `20_000` | `apps/server/src/agentGateway/threadSummary.ts:129`                                     |
| `READ_THREAD_RESPONSE_TEXT_BUDGET`                         |            `20_000` | `apps/server/src/agentGateway/threadSummary.ts:130`                                     |
| `READ_THREAD_DEFAULT_ITEM_LIMIT`                           |                `20` | `apps/server/src/agentGateway/threadSummary.ts:131`                                     |
| `READ_THREAD_MAX_ITEM_LIMIT`                               |               `100` | `apps/server/src/agentGateway/threadSummary.ts:132`                                     |
| `APP_TEST_HOST_STOP_TIMEOUT_MS`                            |             `1_000` | `apps/server/src/appDeveloperTools.ts:8`                                                |
| `APP_TEST_HOST_RESULT_POLL_MS`                             |                `25` | `apps/server/src/appDeveloperTools.ts:9`                                                |
| `APP_TEST_HOST_EXIT_GRACE_MS`                              |               `250` | `apps/server/src/appDeveloperTools.ts:10`                                               |
| `MAX_RESPONSE_BYTES`                                       |      `32*1024*1024` | `apps/server/src/appRuntimeCli.ts:26`                                                   |
| `TIMEOUT_MS`                                               |            `30_000` | `apps/server/src/appRuntimeCli.ts:27`                                                   |
| `APP_OPERATION_TIMEOUT_MS`                                 |         `15*60_000` | `apps/server/src/appRuntimeCli.ts:28`                                                   |
| `DEVELOPER_MUTATION_TIMEOUT_MS`                            |          `5*60_000` | `apps/server/src/appRuntimeCli.ts:29`                                                   |
| `ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS`                   |                `80` | `apps/server/src/attachmentStore.ts:17`                                                 |
| `CAPACITY_RETRY_AFTER_SECONDS`                             |                 `1` | `apps/server/src/auth/Layers/SessionCredentialService.ts:45`                            |
| `CODEX_VERSION_CHECK_TIMEOUT_MS`                           |             `4_000` | `apps/server/src/codexAppServerManager.ts:357`                                          |
| `CODEX_VERSION_CHECK_MAX_OUTPUT_BYTES`                     |         `1024*1024` | `apps/server/src/codexAppServerManager.ts:358`                                          |
| `CODEX_VERSION_CHECK_CACHE_TTL_MS`                         |        `10*60*1000` | `apps/server/src/codexAppServerManager.ts:365`                                          |
| `CODEX_DISCOVERY_SESSION_IDLE_MS`                          |        `10*60*1000` | `apps/server/src/codexAppServerManager.ts:372`                                          |
| `CODEX_PENDING_SETTLE_DEADLINE_MS`                         |             `2_000` | `apps/server/src/codexAppServerManager.ts:373`                                          |
| `CODEX_STDERR_TAIL_MAX_BYTES`                              |           `64*1024` | `apps/server/src/codexAppServerManager.ts:374`                                          |
| `CODEX_STDOUT_END_GRACE_MS`                                |               `100` | `apps/server/src/codexAppServerManager.ts:375`                                          |
| `CODEX_STDERR_RECORD_IDLE_FLUSH_MS`                        |                `50` | `apps/server/src/codexAppServerManager.ts:384`                                          |
| `CODEX_DISCOVERY_CACHE_MAX_ENTRIES`                        |               `128` | `apps/server/src/codexAppServerManager.ts:888`                                          |
| `CODEX_MODEL_DISCOVERY_CACHE_TTL_MS`                       |      `24*60*60_000` | `apps/server/src/codexAppServerManager.ts:889`                                          |
| `CODEX_TEMPORARY_RESOURCE_MAX_BYTES`                       |      `16*1024*1024` | `apps/server/src/codexAppServerManager.ts:890`                                          |
| `limit@2552`                                               |               `100` | `apps/server/src/codexAppServerManager.ts:2552`                                         |
| `limit@2724`                                               |                `50` | `apps/server/src/codexAppServerManager.ts:2724`                                         |
| `CODEX_APP_SERVER_MAX_FRAME_BYTES`                         |      `16*1024*1024` | `apps/server/src/codexAppServerTransport.ts:3`                                          |
| `CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES`                  |      `32*1024*1024` | `apps/server/src/codexAppServerTransport.ts:4`                                          |
| `CODEX_APP_SERVER_MAX_DISCARDED_FRAME_BYTES`               |     `512*1024*1024` | `apps/server/src/codexAppServerTransport.ts:5`                                          |
| `CODEX_APP_SERVER_MAX_JSON_NESTING`                        |               `128` | `apps/server/src/codexAppServerTransport.ts:6`                                          |
| `PARENT_LIVENESS_INTERVAL_MS`                              |             `1_000` | `apps/server/src/desktopParentLifecycle.ts:8`                                           |
| `DEV_SERVER_TERMINAL_COLS`                                 |               `120` | `apps/server/src/devServerManager.ts:33`                                                |
| `DEV_SERVER_TERMINAL_ROWS`                                 |                `30` | `apps/server/src/devServerManager.ts:34`                                                |
| `OPERATIONAL_DIAGNOSTIC_CAP`                               |            `10_000` | `apps/server/src/diagnostics/Layers/ThreadDiagnosticsQuery.ts:12`                       |
| `POWERSHELL_APPX_LOOKUP_TIMEOUT_MS`                        |             `5_000` | `apps/server/src/editorAppDiscovery.ts:43`                                              |
| `POWERSHELL_APPX_LOOKUP_CACHE_TTL_MS`                      |           `300_000` | `apps/server/src/editorAppDiscovery.ts:44`                                              |
| `NEGATIVE_ICON_CACHE_TTL_MS`                               |           `300_000` | `apps/server/src/editorAppIcons.ts:36`                                                  |
| `ICON_MAX_DIMENSION_PX`                                    |               `128` | `apps/server/src/editorAppIcons.ts:40`                                                  |
| `AUTH_JSON_BODY_MAX_BYTES`                                 |           `16*1024` | `apps/server/src/http.ts:80`                                                            |
| `capacity@1046`                                            |                 `1` | `apps/server/src/keybindings.ts:1046`                                                   |
| `LOCAL_PREVIEW_GRANT_TTL_MS`                               |         `2*60*1000` | `apps/server/src/localImageFiles.ts:35`                                                 |
| `PROCESS_OUTPUT_MAX_BUFFER_BYTES`                          |       `2*1024*1024` | `apps/server/src/localServerMonitor.ts:20`                                              |
| `STOP_SIGNAL_SETTLE_MS`                                    |               `450` | `apps/server/src/localServerMonitor.ts:21`                                              |
| `PROCESS_LINEAGE_MAX_DEPTH`                                |                 `4` | `apps/server/src/localServerMonitor.ts:23`                                              |
| `PAGE_TITLE_MAX_CHARS`                                     |               `200` | `apps/server/src/localServerMonitor.ts:24`                                              |
| `PAGE_TITLE_FETCH_TIMEOUT_MS`                              |               `650` | `apps/server/src/localServerMonitor.ts:25`                                              |
| `PAGE_TITLE_MAX_BYTES`                                     |          `128*1024` | `apps/server/src/localServerMonitor.ts:26`                                              |
| `PAGE_TITLE_SUCCESS_TTL_MS`                                |            `30_000` | `apps/server/src/localServerMonitor.ts:27`                                              |
| `PAGE_TITLE_FAILURE_TTL_MS`                                |            `10_000` | `apps/server/src/localServerMonitor.ts:28`                                              |
| `PAGE_TITLE_MAX_URLS_PER_SERVER`                           |                 `3` | `apps/server/src/localServerMonitor.ts:30`                                              |
| `PAGE_TITLE_REDIRECT_LIMIT`                                |                 `3` | `apps/server/src/localServerMonitor.ts:31`                                              |
| `PAGE_TITLE_CACHE_MAX`                                     |               `250` | `apps/server/src/localServerMonitor.ts:32`                                              |
| `MANAGED_ATTACHMENT_WRITING_LEASE_MS`                      |       `10*60*1_000` | `apps/server/src/managedAttachmentCleanup.ts:15`                                        |
| `MANAGED_ATTACHMENT_CLEANUP_BATCH_SIZE`                    |                `64` | `apps/server/src/managedAttachmentCleanup.ts:16`                                        |
| `MANAGED_ATTACHMENT_TOMBSTONE_RETENTION_MS`                | `30*24*60*60*1_000` | `apps/server/src/managedAttachmentCleanup.ts:17`                                        |
| `CLEANUP_LEASE_MS`                                         |            `60_000` | `apps/server/src/managedAttachmentCleanup.ts:18`                                        |
| `MANAGED_ATTACHMENT_STAGING_TTL_MS`                        |       `60*60*1_000` | `apps/server/src/managedAttachmentStore.ts:21`                                          |
| `DEFAULT_MEMORY_DIAGNOSTIC_INTERVAL_MS`                    |         `5*60*1000` | `apps/server/src/memoryDiagnostics.ts:11`                                               |
| `heapLimit@54`                                             |                 `0` | `apps/server/src/memoryDiagnostics.ts:54`                                               |
| `MAX_WEBSOCKET_MESSAGE_BYTES`                              |       `2*1024*1024` | `apps/server/src/nodeHttpServer.ts:10`                                                  |
| `ORCHESTRATION_DISPATCH_TIMEOUT_MS`                        |            `45_000` | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:88`                        |
| `THREAD_TURN_PAGE_SIZE`                                    |                `20` | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:83`                    |
| `HANDLED_TURN_START_KEY_MAX`                               |            `10_000` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:306`                    |
| `PROVIDER_COMMAND_CLAIM_LEASE_MS`                          |            `30_000` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:308`                    |
| `PROVIDER_COMMAND_SAFE_RETRY_LIMIT`                        |                 `3` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:309`                    |
| `Duration.millis@310`                                      |                `50` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:310`                    |
| `Duration.seconds@318`                                     |                `10` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:318`                    |
| `Duration.seconds@319`                                     |                `15` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:319`                    |
| `Duration.seconds@320`                                     |               `120` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:320`                    |
| `Duration.seconds@321`                                     |                 `5` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:321`                    |
| `Duration.millis@2784`                                     |               `250` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:2784`                   |
| `Duration.millis@4500`                                     |                 `5` | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:4500`                   |
| `PROVIDER_RUNTIME_INGESTION_CAPACITY`                      |             `1_024` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:96`                   |
| `PROVIDER_RUNTIME_REPLAY_PAGE_SIZE`                        |               `128` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:97`                   |
| `PROVIDER_RUNTIME_REPLAY_EVENTS_PER_THREAD`                |                `32` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:98`                   |
| `TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY`                  |             `2_048` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:99`                   |
| `BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY`       |             `1_024` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:101`                  |
| `BUFFERED_TOOL_OUTPUT_BY_KEY_CACHE_CAPACITY`               |             `2_048` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:103`                  |
| `BUFFERED_REASONING_SUMMARY_BY_KEY_CACHE_CAPACITY`         |             `2_048` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:105`                  |
| `ACTIVITY_UPDATE_FINGERPRINT_CACHE_CAPACITY`               |             `4_096` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:144`                  |
| `NATIVE_CHILD_IDS_BY_SOURCE_TURN_CACHE_CAPACITY`           |             `2_048` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:147`                  |
| `ASSISTANT_DELIVERY_MODE_BY_TURN_CACHE_CAPACITY`           |             `2_048` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:149`                  |
| `limit@2922`                                               |                 `1` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:2922`                 |
| `Duration.seconds@2986`                                    |                `10` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:2986`                 |
| `PURGE_STARTUP_SWEEP_DELAY_MS`                             |           `60*1000` | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:23`                      |
| `THREAD_LIFECYCLE_REACTOR_CAPACITY`                        |                `64` | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:24`                      |
| `PURGE_FENCE_RETRY_ATTEMPTS`                               |                `20` | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:25`                      |
| `PURGE_FENCE_RETRY_DELAY_MS`                               |               `100` | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:26`                      |
| `ARCHIVE_CLEANUP_RETRY_ATTEMPTS`                           |                 `5` | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:27`                      |
| `ARCHIVE_CLEANUP_RETRY_DELAY_MS`                           |               `100` | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:28`                      |
| `ORCHESTRATION_COMMAND_QUEUE_CAPACITY`                     |               `256` | `apps/server/src/orchestration/orchestrationAdmission.ts:4`                             |
| `ORCHESTRATION_EVENT_PUBSUB_CAPACITY`                      |             `1_024` | `apps/server/src/orchestration/orchestrationAdmission.ts:6`                             |
| `MAX_ACTIVITY_DATA_ARRAY_ITEMS`                            |                `24` | `apps/server/src/orchestration/providerRuntimeActivityProjection.ts:15`                 |
| `stringLimit@280`                                          |               `800` | `apps/server/src/orchestration/providerRuntimeActivityProjection.ts:280`                |
| `ORCHESTRATION_EVENT_TAIL_ROWS`                            |            `10_000` | `apps/server/src/persistence/Layers/OrchestrationEventDeliveries.ts:17`                 |
| `DEFAULT_READ_FROM_SEQUENCE_LIMIT`                         |             `1_000` | `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:83`                      |
| `READ_PAGE_SIZE`                                           |               `500` | `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:84`                      |
| `STALE_RECOVERY_ARTIFACT_AGE_MS`                           |    `24*60*60*1_000` | `apps/server/src/persistence/MigrationBackup.ts:32`                                     |
| `MIGRATION_035_PAGE_SIZE`                                  |               `128` | `apps/server/src/persistence/Migrations/035_NormalizeLegacyModelSelectionOptions.ts:11` |
| `MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS`                  |                 `8` | `apps/server/src/persistence/Services/ManagedAttachments.ts:45`                         |
| `DEFAULT_MANAGED_ATTACHMENT_LIMITS.homeBytes`              |  `5*1024*1024*1024` | `apps/server/src/persistence/Services/ManagedAttachments.ts:55`                         |
| `DEFAULT_MANAGED_ATTACHMENT_LIMITS.homeCount`              |            `20_000` | `apps/server/src/persistence/Services/ManagedAttachments.ts:56`                         |
| `DEFAULT_MANAGED_ATTACHMENT_LIMITS.principalStagingBytes`  |     `256*1024*1024` | `apps/server/src/persistence/Services/ManagedAttachments.ts:57`                         |
| `DEFAULT_MANAGED_ATTACHMENT_LIMITS.principalStagingCount`  |                `16` | `apps/server/src/persistence/Services/ManagedAttachments.ts:58`                         |
| `PROVIDER_RUNTIME_EVENT_MAX_BYTES`                         |       `2*1024*1024` | `apps/server/src/persistence/Services/ProviderRuntimeEvents.ts:8`                       |
| `PROVIDER_RUNTIME_PROJECTION_FAILURE_ATTEMPT_LIMIT`        |                `12` | `apps/server/src/persistence/Services/ProviderRuntimeEvents.ts:10`                      |
| `PROVIDER_RUNTIME_PROJECTION_FAILURE_MIN_BLOCKED_MS`       |            `30_000` | `apps/server/src/persistence/Services/ProviderRuntimeEvents.ts:11`                      |
| `PROVIDER_RUNTIME_PROJECTION_RETRY_BASE_MS`                |               `250` | `apps/server/src/persistence/Services/ProviderRuntimeEvents.ts:12`                      |
| `PROVIDER_RUNTIME_PROJECTION_RETRY_MAX_MS`                 |             `5_000` | `apps/server/src/persistence/Services/ProviderRuntimeEvents.ts:13`                      |
| `DEFAULT_MAX_BUFFER_BYTES`                                 |       `8*1024*1024` | `apps/server/src/processRunner.ts:83`                                                   |
| `DEFAULT_WORKFLOW_RUNTIME_POLL_INTERVAL_MS`                |             `2_000` | `apps/server/src/provider/Layers/ClaudeAdapter.ts:750`                                  |
| `CLAUDE_CONTEXT_USAGE_TIMEOUT_MS`                          |             `1_000` | `apps/server/src/provider/Layers/ClaudeAdapter.ts:1006`                                 |
| `CLAUDE_NATIVE_RESUME_VERIFICATION_TIMEOUT_MS`             |            `60_000` | `apps/server/src/provider/Layers/ClaudeAdapter.ts:1007`                                 |
| `Duration.seconds@1013`                                    |                `10` | `apps/server/src/provider/Layers/ClaudeAdapter.ts:1013`                                 |
| `MODEL_DISCOVERY_CACHE_TTL_MS`                             |      `24*60*60_000` | `apps/server/src/provider/Layers/ClaudeAdapter.ts:5868`                                 |
| `CODEX_ROLLOUT_ADOPTION_ATTEMPTS`                          |                `50` | `apps/server/src/provider/Layers/CodexAdapter.ts:101`                                   |
| `CODEX_ROLLOUT_ADOPTION_RETRY_MS`                          |                `20` | `apps/server/src/provider/Layers/CodexAdapter.ts:102`                                   |
| `CODEX_TURN_WATCHDOG_INTERVAL_MS`                          |            `15_000` | `apps/server/src/provider/Layers/CodexAdapter.ts:137`                                   |
| `DEFAULT_MAX_BYTES`                                        |      `10*1024*1024` | `apps/server/src/provider/Layers/EventNdjsonLogger.ts:21`                               |
| `DEFAULT_MAX_FILES`                                        |                `10` | `apps/server/src/provider/Layers/EventNdjsonLogger.ts:22`                               |
| `DEFAULT_BATCH_WINDOW_MS`                                  |               `200` | `apps/server/src/provider/Layers/EventNdjsonLogger.ts:23`                               |
| `OPENCODE_PROMPT_ACCEPTED_ACTIVITY_TIMEOUT_MS`             |            `60_000` | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:124`                                |
| `OPENCODE_PROMPT_SUBMISSION_INLINE_WAIT_MS`                |               `500` | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:126`                                |
| `OPENCODE_MAX_RELATED_SESSIONS`                            |               `256` | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:128`                                |
| `OPENCODE_ABORT_IDLE_POLL_INTERVAL_MS`                     |                `50` | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:129`                                |
| `OPENCODE_ABORT_IDLE_MAX_POLLS`                            |                `40` | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:130`                                |
| `Effect.sleep@3212`                                        |               `500` | `apps/server/src/provider/Layers/OpenCodeAdapter.ts:3212`                               |
| `DEFAULT_TIMEOUT_MS`                                       |             `4_000` | `apps/server/src/provider/Layers/ProviderHealth.ts:85`                                  |
| `CLAUDE_HEALTH_TIMEOUT_MS`                                 |            `20_000` | `apps/server/src/provider/Layers/ProviderHealth.ts:86`                                  |
| `OPENCODE_HEALTH_TIMEOUT_MS`                               |            `20_000` | `apps/server/src/provider/Layers/ProviderHealth.ts:87`                                  |
| `CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS`                |             `1_000` | `apps/server/src/provider/Layers/ProviderHealth.ts:745`                                 |
| `DEFAULT_RECONCILIATION_INTERVAL_MS`                       |             `5_000` | `apps/server/src/provider/Layers/ProviderRuntimeReconciler.ts:37`                       |
| `DEFAULT_RECONCILIATION_CANDIDATE_LIMIT`                   |               `256` | `apps/server/src/provider/Layers/ProviderRuntimeReconciler.ts:38`                       |
| `DEFAULT_PROVIDER_RUNTIME_IDLE_STOP_MS`                    |        `10*60*1000` | `apps/server/src/provider/Layers/ProviderService.ts:152`                                |
| `PROVIDER_RUNTIME_EVENT_BUFFER_CAPACITY`                   |             `2_048` | `apps/server/src/provider/Layers/ProviderService.ts:153`                                |
| `PROVIDER_RUNTIME_QUARANTINE_CAUSE_MAX_BYTES`              |           `16*1024` | `apps/server/src/provider/Layers/ProviderService.ts:154`                                |
| `Duration.seconds@209`                                     |                `60` | `apps/server/src/provider/Layers/ProviderService.ts:209`                                |
| `Duration.seconds@210`                                     |                `10` | `apps/server/src/provider/Layers/ProviderService.ts:210`                                |
| `DEFAULT_INACTIVITY_THRESHOLD_MS`                          |        `30*60*1000` | `apps/server/src/provider/Layers/ProviderSessionReaper.ts:11`                           |
| `DEFAULT_SWEEP_INTERVAL_MS`                                |         `5*60*1000` | `apps/server/src/provider/Layers/ProviderSessionReaper.ts:12`                           |
| `PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY`           |             `2_048` | `apps/server/src/provider/Services/ProviderAdapter.ts:55`                               |
| `DEFAULT_INTERVAL_MINUTES`                                 |                `30` | `apps/server/src/provider/claudeCredentialKeepalive.ts:32`                              |
| `COMMAND_TIMEOUT_MS`                                       |            `20_000` | `apps/server/src/provider/claudeCredentialKeepalive.ts:33`                              |
| `CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS`              |     `2_147_483_647` | `apps/server/src/provider/claudeCredentialKeepalive.ts:34`                              |
| `MAX_CLAUDE_WORKFLOW_FILE_BYTES`                           |       `5*1024*1024` | `apps/server/src/provider/claudeWorkflowRuntime.ts:17`                                  |
| `MAX_CHUNK_BYTES`                                          |          `512*1024` | `apps/server/src/provider/claudeWorkflowRuntime.ts:18`                                  |
| `COMMAND_OUTPUT_LIMIT`                                     |           `64*1024` | `apps/server/src/provider/managedProviderArtifactInstaller.ts:22`                       |
| `MAX_ARTIFACT_BYTES`                                       |     `512*1024*1024` | `apps/server/src/provider/managedProviderArtifactInstaller.ts:23`                       |
| `DEFAULT_OPENCODE_SERVER_TIMEOUT_MS`                       |            `20_000` | `apps/server/src/provider/opencodeRuntime.ts:49`                                        |
| `OPENCODE_LOCAL_SERVER_IDLE_TTL_MS`                        |          `5*60_000` | `apps/server/src/provider/opencodeRuntime.ts:51`                                        |
| `OPENCODE_STARTUP_OUTPUT_MAX_CHARS`                        |             `4_000` | `apps/server/src/provider/opencodeRuntime.ts:52`                                        |
| `timeout@85`                                               |            `15_000` | `apps/server/src/provider/providerConnectionManifests.ts:85`                            |
| `TIMEOUT_MS`                                               |            `10_000` | `apps/server/src/provider/providerCredentialBroker.ts:10`                               |
| `MAX_RESPONSE_BYTES`                                       |          `128*1024` | `apps/server/src/provider/providerCredentialBroker.ts:11`                               |
| `Duration.millis@54`                                       |               `100` | `apps/server/src/provider/providerLifecycleCoordinator.ts:54`                           |
| `Duration.millis@55`                                       |                `25` | `apps/server/src/provider/providerLifecycleCoordinator.ts:55`                           |
| `PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES`               |      `32*1024*1024` | `apps/server/src/provider/providerRuntimeEventIngress.ts:3`                             |
| `PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE`               |                `64` | `apps/server/src/provider/providerRuntimeEventIngress.ts:4`                             |
| `PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES`                 |          `512*1024` | `apps/server/src/provider/providerRuntimeEventIngress.ts:5`                             |
| `DEFAULT_RETRY_BASE_DELAY_MS`                              |                `25` | `apps/server/src/provider/providerRuntimeEventPump.ts:18`                               |
| `DEFAULT_RETRY_MAX_DELAY_MS`                               |             `2_000` | `apps/server/src/provider/providerRuntimeEventPump.ts:19`                               |
| `DEFAULT_RUNTIME_RECONCILIATION_STALE_AFTER_MS`            |            `15_000` | `apps/server/src/provider/providerRuntimeReconciliation.ts:22`                          |
| `PROVIDER_UPDATE_HISTORY_LIMIT`                            |               `100` | `apps/server/src/provider/providerUpdateCoordinator.ts:57`                              |
| `SKILLS_CATALOG_CACHE_TTL_MS`                              |            `15_000` | `apps/server/src/provider/skillsCatalog.ts:327`                                         |
| `SKILLS_CATALOG_CACHE_MAX_ENTRIES`                         |                `64` | `apps/server/src/provider/skillsCatalog.ts:328`                                         |
| `DEFAULT_TERM_GRACE_MS`                                    |             `1_500` | `apps/server/src/provider/supervisedProcessTeardown.ts:10`                              |
| `DEFAULT_FORCE_EXIT_MS`                                    |             `1_500` | `apps/server/src/provider/supervisedProcessTeardown.ts:11`                              |
| `DEFAULT_POLL_MS`                                          |                `25` | `apps/server/src/provider/supervisedProcessTeardown.ts:12`                              |
| `DEFAULT_CAPTURE_RETRY_ATTEMPTS`                           |                 `3` | `apps/server/src/provider/supervisedProcessTeardown.ts:13`                              |
| `DEFAULT_CAPTURE_RETRY_MS`                                 |                `25` | `apps/server/src/provider/supervisedProcessTeardown.ts:14`                              |
| `DEFAULT_INSPECT_INTERVAL_MS`                              |               `250` | `apps/server/src/provider/supervisedProcessTeardown.ts:18`                              |
| `THREAD_MENTION_MESSAGE_LIMIT`                             |                `20` | `apps/server/src/provider/threadMentionContext.ts:21`                                   |
| `THREAD_MENTION_MAX_MESSAGE_CHARS`                         |             `1_500` | `apps/server/src/provider/threadMentionContext.ts:22`                                   |
| `THREAD_MENTION_MAX_CONTEXT_CHARS`                         |             `8_000` | `apps/server/src/provider/threadMentionContext.ts:23`                                   |
| `THREAD_MENTION_MAX_TOTAL_CONTEXT_CHARS`                   |            `16_000` | `apps/server/src/provider/threadMentionContext.ts:24`                                   |
| `THREAD_MENTION_MIN_CONTEXT_CHARS`                         |               `256` | `apps/server/src/provider/threadMentionContext.ts:28`                                   |
| `DEFAULT_OAUTH_REFRESH_TIMEOUT_MS`                         |            `15_000` | `apps/server/src/providerUsage/credentials.ts:10`                                       |
| `DEFAULT_TIMEOUT_MS`                                       |            `10_000` | `apps/server/src/providerUsage/http.ts:13`                                              |
| `CONNECTION_USAGE_CACHE_TTL_MS`                            |            `60_000` | `apps/server/src/providerUsage/index.ts:42`                                             |
| `REFRESH_BUFFER_MS`                                        |         `5*60*1000` | `apps/server/src/providerUsage/providers/claude.ts:40`                                  |
| `CLAUDE_USAGE_COMMAND_TIMEOUT_MS`                          |            `15_000` | `apps/server/src/providerUsage/providers/claude.ts:41`                                  |
| `DEFAULT_RATE_LIMIT_COOLDOWN_MS`                           |         `5*60*1000` | `apps/server/src/providerUsage/rateLimitResilience.ts:14`                               |
| `MAX_RATE_LIMIT_COOLDOWN_MS`                               |        `15*60*1000` | `apps/server/src/providerUsage/rateLimitResilience.ts:16`                               |
| `ONE_DAY_MS`                                               |     `24*60*60*1000` | `apps/server/src/providerUsageSnapshot.ts:20`                                           |
| `LOOKBACK_7D_MS`                                           |                 `7` | `apps/server/src/providerUsageSnapshot.ts:21`                                           |
| `USAGE_CACHE_TTL_MS`                                       |            `30_000` | `apps/server/src/providerUsageSnapshot.ts:23`                                           |
| `FAVICON_CACHE_MAX`                                        |               `500` | `apps/server/src/siteFaviconCache.ts:12`                                                |
| `FAVICON_SUCCESS_TTL_MS`                                   |     `24*60*60*1000` | `apps/server/src/siteFaviconCache.ts:13`                                                |
| `FAVICON_FAILURE_TTL_MS`                                   |        `60*60*1000` | `apps/server/src/siteFaviconCache.ts:14`                                                |
| `REMOTE_FETCH_TIMEOUT_MS`                                  |             `5_000` | `apps/server/src/siteFaviconCache.ts:15`                                                |
| `DIRECT_FETCH_TIMEOUT_MS`                                  |             `3_000` | `apps/server/src/siteFaviconCache.ts:16`                                                |
| `MAX_FAVICON_BYTES`                                        |          `512*1024` | `apps/server/src/siteFaviconCache.ts:17`                                                |
| `Effect.sleep@139`                                         |              `1000` | `apps/server/src/telemetry/Layers/AnalyticsService.ts:139`                              |
| `PAUSE_BUFFER_LIMIT`                                       |       `8*1024*1024` | `apps/server/src/terminal/Layers/BunPTY.ts:10`                                          |
| `DEFAULT_HISTORY_LINE_LIMIT`                               |             `5_000` | `apps/server/src/terminal/Layers/Manager.ts:75`                                         |
| `DEFAULT_PERSIST_DEBOUNCE_MS`                              |               `250` | `apps/server/src/terminal/Layers/Manager.ts:76`                                         |
| `DEFAULT_SUBPROCESS_POLL_INTERVAL_MS`                      |             `1_000` | `apps/server/src/terminal/Layers/Manager.ts:77`                                         |
| `DEFAULT_PROCESS_KILL_GRACE_MS`                            |             `1_000` | `apps/server/src/terminal/Layers/Manager.ts:85`                                         |
| `DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS`                   |               `128` | `apps/server/src/terminal/Layers/Manager.ts:86`                                         |
| `OUTPUT_BATCH_INTERVAL_MS`                                 |                `16` | `apps/server/src/terminal/Layers/Manager.ts:88`                                         |
| `OUTPUT_BATCH_SIZE_LIMIT`                                  |           `131_072` | `apps/server/src/terminal/Layers/Manager.ts:90`                                         |
| `OUTPUT_ACK_RESUME_TIMEOUT_MS`                             |            `10_000` | `apps/server/src/terminal/Layers/Manager.ts:102`                                        |
| `DEFAULT_OPEN_ROWS`                                        |                `30` | `apps/server/src/terminal/Layers/Manager.ts:104`                                        |
| `PROVIDER_INPUT_ACTIVITY_GRACE_MS`                         |           `120_000` | `apps/server/src/terminal/Layers/Manager.ts:105`                                        |
| `PROVIDER_OUTPUT_ACTIVITY_GRACE_MS`                        |            `30_000` | `apps/server/src/terminal/Layers/Manager.ts:106`                                        |
| `SHUTDOWN_ESCALATION_SETTLE_MS`                            |                `25` | `apps/server/src/terminal/Layers/Manager.ts:107`                                        |
| `PROCESS_TREE_SCAN_TIMEOUT_MS`                             |             `1_000` | `apps/server/src/terminal/processTreeKiller.ts:9`                                       |
| `PROCESS_TREE_SCAN_MAX_BUFFER_BYTES`                       |         `8_388_608` | `apps/server/src/terminal/processTreeKiller.ts:13`                                      |
| `PROCESS_COMMAND_SCAN_MAX_BUFFER_BYTES`                    |         `8_388_608` | `apps/server/src/terminal/processTreeKiller.ts:14`                                      |
| `POSIX_TREE_WALK_MAX_VISITED`                              |               `256` | `apps/server/src/terminal/processTreeKiller.ts:15`                                      |
| `POSIX_SUBPROCESS_TREE_WALK_MAX_VISITED`                   |               `256` | `apps/server/src/terminal/subprocessActivity.ts:15`                                     |
| `timeoutMs@37`                                             |             `1_500` | `apps/server/src/terminal/subprocessActivity.ts:37`                                     |
| `timeoutMs@137`                                            |             `1_000` | `apps/server/src/terminal/subprocessActivity.ts:137`                                    |
| `timeoutMs@154`                                            |             `1_000` | `apps/server/src/terminal/subprocessActivity.ts:154`                                    |
| `timeoutMs@173`                                            |             `1_000` | `apps/server/src/terminal/subprocessActivity.ts:173`                                    |
| `timeoutMs@223`                                            |             `1_000` | `apps/server/src/terminal/subprocessActivity.ts:223`                                    |
| `DEFAULT_HISTORY_BYTE_LIMIT`                               |         `1_048_576` | `apps/server/src/terminal/terminalHistory.ts:8`                                         |
| `CODEX_TIMEOUT_MS`                                         |           `180_000` | `apps/server/src/textGeneration/Layers/CodexTextGeneration.ts:26`                       |
| `THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS`                  |         `5*60*1000` | `apps/server/src/threadRetention.ts:27`                                                 |
| `THREAD_RETENTION_SWEEP_INTERVAL_MS`                       |     `24*60*60*1000` | `apps/server/src/threadRetention.ts:28`                                                 |
| `THREAD_RETENTION_BATCH_SIZE`                              |                `25` | `apps/server/src/threadRetention.ts:29`                                                 |
| `THREAD_RETENTION_BATCH_PAUSE_MS`                          |                `50` | `apps/server/src/threadRetention.ts:30`                                                 |
| `DEFAULT_READ_FILE_MAX_BYTES`                              |         `1_000_000` | `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts:24`                            |
| `WORKSPACE_CACHE_TTL_MS`                                   |            `15_000` | `apps/server/src/workspaceEntries.ts:27`                                                |
| `WORKSPACE_CACHE_MAX_KEYS`                                 |                 `4` | `apps/server/src/workspaceEntries.ts:28`                                                |
| `WORKSPACE_INDEX_MAX_ENTRIES`                              |            `25_000` | `apps/server/src/workspaceEntries.ts:29`                                                |
| `PROJECT_PACKAGE_JSON_MAX_BYTES`                           |         `1024*1024` | `apps/server/src/workspaceEntries.ts:32`                                                |
| `PROJECT_PACKAGE_SCAN_MAX_TARGETS`                         |                `80` | `apps/server/src/workspaceEntries.ts:33`                                                |
| `GIT_CHECK_IGNORE_MAX_STDIN_BYTES`                         |          `256*1024` | `apps/server/src/workspaceEntries.ts:35`                                                |
| `timeoutMs@451`                                            |             `5_000` | `apps/server/src/workspaceEntries.ts:451`                                               |
| `timeoutMs@479`                                            |            `20_000` | `apps/server/src/workspaceEntries.ts:479`                                               |
| `timeoutMs@554`                                            |            `20_000` | `apps/server/src/workspaceEntries.ts:554`                                               |
| `LOCAL_SEARCH_MAX_DEPTH`                                   |                 `6` | `apps/server/src/workspaceEntries.ts:975`                                               |
| `LOCAL_SEARCH_DEFAULT_LIMIT`                               |                `50` | `apps/server/src/workspaceEntries.ts:976`                                               |
| `LOCAL_SEARCH_TIME_BUDGET_MS`                              |               `600` | `apps/server/src/workspaceEntries.ts:977`                                               |
| `CHANGE_DEBOUNCE_MS`                                       |               `150` | `apps/server/src/workspaceWatcher.ts:13`                                                |
| `WS_REQUEST_CLASS_LIMITS.control`                          |                `16` | `apps/server/src/wsRequestAdmission.ts:9`                                               |
| `WS_REQUEST_CLASS_LIMITS.standard`                         |                `12` | `apps/server/src/wsRequestAdmission.ts:10`                                              |
| `WS_REQUEST_CLASS_LIMITS.expensive-read`                   |                 `2` | `apps/server/src/wsRequestAdmission.ts:11`                                              |
| `retryAfterMs@107`                                         |               `250` | `apps/server/src/wsRequestAdmission.ts:107`                                             |
| `ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT`                      |             `4_096` | `apps/server/src/wsSnapshotLiveStream.ts:4`                                             |
| `STREAM_CAPACITY_RETRY_AFTER_MS`                           |             `1_000` | `apps/server/src/wsStreamAdmission.ts:7`                                                |
| `DEFAULT_LIVE_UI_STREAM_BUFFER_CAPACITY`                   |             `1_024` | `apps/server/src/wsStreamBackpressure.ts:9`                                             |
| `MAX_CUSTOM_MODEL_COUNT`                                   |                `32` | `apps/web/src/appSettings.ts:45`                                                        |
| `MIN_CHAT_FONT_SIZE_PX`                                    |                `11` | `apps/web/src/appSettings.ts:47`                                                        |
| `MAX_CHAT_FONT_SIZE_PX`                                    |                `18` | `apps/web/src/appSettings.ts:48`                                                        |
| `DEFAULT_CHAT_FONT_SIZE_PX`                                |                `13` | `apps/web/src/appSettings.ts:49`                                                        |
| `MIN_TERMINAL_FONT_SIZE_PX`                                |                `10` | `apps/web/src/appSettings.ts:50`                                                        |
| `MAX_TERMINAL_FONT_SIZE_PX`                                |                `22` | `apps/web/src/appSettings.ts:51`                                                        |
| `DEFAULT_TERMINAL_FONT_SIZE_PX`                            |                `12` | `apps/web/src/appSettings.ts:52`                                                        |
| `PERSISTED_SYNC_INCIDENT_MAX_AGE_MS`                       |       `10*60*1_000` | `apps/web/src/chatLifecycleDiagnostics.ts:177`                                          |
| `EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS`                    |             `1_800` | `apps/web/src/chatRouteRestore.ts:12`                                                   |
| `attachmentResponseDelayMs`                                |                 `0` | `apps/web/src/components/ChatView.browser.tsx:136`                                      |
| `lostPointerCaptureCount`                                  |                 `0` | `apps/web/src/components/ChatView.browser.tsx:7668`                                     |
| `PROMPT_HISTORY_MAX_ENTRIES`                               |               `100` | `apps/web/src/components/ChatView.logic.ts:41`                                          |
| `ATTACHMENT_PREVIEW_HANDOFF_TTL_MS`                        |              `5000` | `apps/web/src/components/ChatView.tsx:466`                                              |
| `DRAFT_PROJECT_SYNC_MAX_ATTEMPTS`                          |                 `6` | `apps/web/src/components/ChatView.tsx:533`                                              |
| `DRAFT_PROJECT_SYNC_DELAY_MS`                              |                `50` | `apps/web/src/components/ChatView.tsx:534`                                              |
| `COMPOSER_INPUT_BURST_IDLE_MS`                             |                `50` | `apps/web/src/components/ChatView.tsx:535`                                              |
| `COMPOSER_PATH_QUERY_DEBOUNCE_MS`                          |               `120` | `apps/web/src/components/ChatView.tsx:785`                                              |
| `VOICE_RECORDER_ACTION_ARM_DELAY_MS`                       |               `250` | `apps/web/src/components/ChatView.tsx:786`                                              |
| `limit@3580`                                               |                `80` | `apps/web/src/components/ChatView.tsx:3580`                                             |
| `SIDEBAR_THREAD_PREWARM_LIMIT`                             |                `10` | `apps/web/src/components/Sidebar.logic.ts:28`                                           |
| `THREAD_PREVIEW_LIMIT`                                     |                 `5` | `apps/web/src/components/Sidebar.tsx:235`                                               |
| `THREAD_PREVIEW_PAGE_SIZE`                                 |                 `5` | `apps/web/src/components/Sidebar.tsx:237`                                               |
| `MAX_PERSISTED_THREAD_LIST_EXTRA_PAGES`                    |              `1000` | `apps/web/src/components/Sidebar.uiState.ts:30`                                         |
| `SNIPPET_MAX_LENGTH`                                       |                `88` | `apps/web/src/components/SidebarSearchPalette.logic.ts:94`                              |
| `SEARCH_DEBOUNCE_MS`                                       |                `90` | `apps/web/src/components/TerminalSearch.tsx:26`                                         |
| `COLOR_PICKER_COMMIT_DELAY_MS`                             |               `220` | `apps/web/src/components/ThemePackEditor.tsx:50`                                        |
| `LOCAL_SEARCH_DEBOUNCE_MS`                                 |               `220` | `apps/web/src/components/chat/ComposerLocalDirectoryMenu.tsx:38`                        |
| `LOCAL_SEARCH_MIN_QUERY_LENGTH`                            |                 `2` | `apps/web/src/components/chat/ComposerLocalDirectoryMenu.tsx:39`                        |
| `ANCHORED_TOAST_TIMEOUT_MS`                                |              `1000` | `apps/web/src/components/chat/MessageCopyButton.tsx:7`                                  |
| `JUMP_HIGHLIGHT_DURATION_MS`                               |              `1200` | `apps/web/src/components/chat/MessagesTimeline.tsx:158`                                 |
| `MESSAGE_SEND_ENTER_ANIMATION_MS`                          |               `180` | `apps/web/src/components/chat/MessagesTimeline.tsx:159`                                 |
| `MESSAGE_SEND_ENTER_CLEANUP_BUFFER_MS`                     |                `60` | `apps/web/src/components/chat/MessagesTimeline.tsx:160`                                 |
| `RIGHT_DOCK_MIN_WIDTH`                                     |             `26*16` | `apps/web/src/components/chat/RightDock.tsx:42`                                         |
| `APP_PANEL_MIN_WIDTH`                                      |             `26*16` | `apps/web/src/components/chat/SingleChatSurface.tsx:57`                                 |
| `THREAD_PANEL_MIN_WIDTH`                                   |               `400` | `apps/web/src/components/chat/SingleChatSurface.tsx:58`                                 |
| `OVERSCAN_ROWS`                                            |                 `6` | `apps/web/src/components/chat/TranscriptVirtualList.tsx:61`                             |
| `INITIAL_END_CORRECTION_DELAY_MS`                          |                `16` | `apps/web/src/components/chat/TranscriptVirtualList.tsx:62`                             |
| `APP_TAB_HOST_READY_RETRY_LIMIT`                           |                `50` | `apps/web/src/components/chat/appTabRestore.logic.ts:14`                                |
| `APPS_LAUNCHER_BUTTON_SIZE_PX`                             |                `32` | `apps/web/src/components/chat/appsLauncher.logic.ts:8`                                  |
| `SUBAGENT_TOOL_TRACE_MAX_ITEMS`                            |                 `4` | `apps/web/src/components/chat/subagentToolTrace.logic.ts:12`                            |
| `MIN_COLLAPSIBLE_TOOL_GROUP_SIZE`                          |                 `2` | `apps/web/src/components/chat/toolCallGroup.logic.ts:15`                                |
| `COLLAPSED_USER_MESSAGE_MAX_CHARS`                         |               `600` | `apps/web/src/components/chat/userMessageCollapse.ts:4`                                 |
| `USER_MESSAGE_COLLAPSED_MAX_LINES`                         |                `12` | `apps/web/src/components/chat/userMessageCollapse.ts:5`                                 |
| `COMPOSER_FOOTER_MAX_TIER`                                 |                 `3` | `apps/web/src/components/composerFooterLayout.ts:33`                                    |
| `BAR_MIN_HEIGHT_PX`                                        |                 `3` | `apps/web/src/components/middle-panel/voice-recorder-shared/VoiceRecorderShared.tsx:20` |
| `BAR_MAX_HEIGHT_PX`                                        |                `22` | `apps/web/src/components/middle-panel/voice-recorder-shared/VoiceRecorderShared.tsx:21` |
| `AVATAR_MAX_EDGE`                                          |               `160` | `apps/web/src/components/profile/avatarImage.ts:11`                                     |
| `AVATAR_MAX_DATA_URL_LENGTH`                               |           `200_000` | `apps/web/src/components/profile/avatarImage.ts:16`                                     |
| `MIN_TERMINAL_PANE_SIZE_PX`                                |               `180` | `apps/web/src/components/terminal/TerminalViewportPane.tsx:36`                          |
| `DEFAULT_FONT_LOAD_TIMEOUT_MS`                             |             `2_000` | `apps/web/src/components/terminal/terminalFontSettle.ts:7`                              |
| `MAX_TERMINAL_PERF_SAMPLES`                                |               `200` | `apps/web/src/components/terminal/terminalPerformance.ts:25`                            |
| `VISUAL_RESIZE_MIN_INTERVAL_MS`                            |                `64` | `apps/web/src/components/terminal/terminalRuntime.ts:58`                                |
| `BACKEND_RESIZE_DEBOUNCE_MS`                               |               `120` | `apps/web/src/components/terminal/terminalRuntime.ts:59`                                |
| `WRITE_BATCH_SIZE_LIMIT`                                   |           `262_144` | `apps/web/src/components/terminal/terminalRuntime.ts:60`                                |
| `WRITE_BATCH_MAX_LATENCY_MS`                               |                `50` | `apps/web/src/components/terminal/terminalRuntime.ts:61`                                |
| `LINK_MATCH_CACHE_LIMIT`                                   |               `512` | `apps/web/src/components/terminal/terminalRuntime.ts:62`                                |
| `OPEN_SNAPSHOT_RECONCILE_DELAY_MS`                         |               `250` | `apps/web/src/components/terminal/terminalRuntime.ts:63`                                |
| `TERMINAL_CURSOR_WIDTH`                                    |                 `1` | `apps/web/src/components/terminal/terminalRuntime.ts:77`                                |
| `RECOVERY_THROTTLE_MS`                                     |               `120` | `apps/web/src/components/terminal/terminalRuntime.ts:417`                               |
| `FALLBACK_TERMINAL_FONT_SIZE_PX`                           |                `12` | `apps/web/src/components/terminal/terminalRuntimeAppearance.ts:9`                       |
| `TERMINAL_FONT_WEIGHT`                                     |               `300` | `apps/web/src/components/terminal/terminalRuntimeAppearance.ts:10`                      |
| `TERMINAL_BOLD_FONT_WEIGHT`                                |               `500` | `apps/web/src/components/terminal/terminalRuntimeAppearance.ts:11`                      |
| `MULTI_CLICK_SELECTION_ACTION_DELAY_MS`                    |               `260` | `apps/web/src/components/terminal/terminalSelectionActions.ts:5`                        |
| `USER_ATTACHMENT_THUMBNAIL_SIZE_PX`                        |                `60` | `apps/web/src/components/timelineHeight.ts:22`                                          |
| `SIDEBAR_COOKIE_MAX_AGE`                                   |        `60*60*24*7` | `apps/web/src/components/ui/sidebar.tsx:25`                                             |
| `SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH`                         |             `16*16` | `apps/web/src/components/ui/sidebar.tsx:29`                                             |
| `COMPOSER_PERSIST_DEBOUNCE_MS`                             |               `250` | `apps/web/src/composerDraftStore.ts:72`                                                 |
| `FEEDBACK_REQUEST_TIMEOUT_MS`                              |            `20_000` | `apps/web/src/feedback.ts:56`                                                           |
| `THREAD_MENTION_SUGGESTION_LIMIT`                          |                `20` | `apps/web/src/hooks/useComposerCommandMenuItems.ts:54`                                  |
| `PROVIDER_AUTH_REFRESH_MIN_INTERVAL_MS`                    |            `15_000` | `apps/web/src/hooks/useProviderAuthRefreshOnFocus.ts:12`                                |
| `ARCHIVE_UNDO_TOAST_DURATION_MS`                           |              `8000` | `apps/web/src/hooks/useSidebarThreadActions.ts:41`                                      |
| `BASE_COMPOSER_EDITOR_MIN_HEIGHT_REM`                      |                 `1` | `apps/web/src/lib/appDensity.ts:18`                                                     |
| `ASSISTANT_SELECTION_PREVIEW_MAX_CHARS`                    |                `44` | `apps/web/src/lib/assistantSelections.ts:14`                                            |
| `ORPHANED_BLOB_MIN_AGE_MS`                                 |        `60*60*1000` | `apps/web/src/lib/composerImageBlobStore.ts:11`                                         |
| `PASTED_TEXT_MIN_LINES`                                    |                `25` | `apps/web/src/lib/composerPastedText.ts:35`                                             |
| `PASTED_TEXT_MIN_CHARS`                                    |              `4000` | `apps/web/src/lib/composerPastedText.ts:36`                                             |
| `ATTACHMENT_CANCEL_BODY_MAX_BYTES`                         |               `512` | `apps/web/src/lib/composerSend.ts:36`                                                   |
| `DISCLOSURE_TRANSITION_MS`                                 |               `150` | `apps/web/src/lib/disclosureMotion.ts:13`                                               |
| `FILE_COMMENT_TEXT_MAX_CHARS`                              |             `4_000` | `apps/web/src/lib/fileComments.ts:11`                                                   |
| `FILE_COMMENT_PREVIEW_MAX_CHARS`                           |                `44` | `apps/web/src/lib/fileComments.ts:12`                                                   |
| `DEFAULT_SEARCH_TIMEOUT_MS`                                |             `3_000` | `apps/web/src/lib/find/findCoordinator.ts:42`                                           |
| `searchTimeoutMs@47`                                       |            `15_000` | `apps/web/src/lib/find/pdfFindSurface.ts:47`                                            |
| `NO_ACTIVITY_THRESHOLD_MS`                                 |            `30_000` | `apps/web/src/lib/liveActivityPresentation.ts:11`                                       |
| `LIVE_ACTIVITY_TICK_MS`                                    |             `1_000` | `apps/web/src/lib/liveActivityPresentation.ts:12`                                       |
| `COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX`              |               `160` | `apps/web/src/lib/panelResize.ts:16`                                                    |
| `PDF_MIN_SCALE`                                            |                 `0` | `apps/web/src/lib/pdf/pdfZoom.ts:12`                                                    |
| `PDF_MAX_SCALE`                                            |                 `5` | `apps/web/src/lib/pdf/pdfZoom.ts:13`                                                    |
| `DEFAULT_DEBOUNCE_MS`                                      |               `120` | `apps/web/src/lib/pdf/useContainerSize.ts:13`                                           |
| `DEFAULT_RECOVERY_MAX_ATTEMPTS`                            |                 `6` | `apps/web/src/lib/projectCreateRecovery.ts:10`                                          |
| `DEFAULT_RECOVERY_DELAY_MS`                                |                `50` | `apps/web/src/lib/projectCreateRecovery.ts:11`                                          |
| `DEFAULT_SEARCH_ENTRIES_LIMIT`                             |                `80` | `apps/web/src/lib/projectReactQuery.ts:49`                                              |
| `DEFAULT_SEARCH_LOCAL_ENTRIES_LIMIT`                       |                `50` | `apps/web/src/lib/projectReactQuery.ts:54`                                              |
| `LOCAL_PREVIEW_GRANT_REFRESH_SAFETY_MS`                    |            `15_000` | `apps/web/src/lib/projectReactQuery.ts:57`                                              |
| `LOCAL_PREVIEW_GRANT_MIN_REFETCH_INTERVAL_MS`              |             `1_000` | `apps/web/src/lib/projectReactQuery.ts:58`                                              |
| `LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS`              |            `30_000` | `apps/web/src/lib/projectReactQuery.ts:59`                                              |
| `PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS`                    |            `15_000` | `apps/web/src/lib/projectSnapshotHydration.ts:13`                                       |
| `OPENCODE_MODEL_CACHE_MAX_AGE_MS`                          |    `7*24*60*60_000` | `apps/web/src/lib/providerDiscoveryReactQuery.ts:51`                                    |
| `PROVIDER_MODEL_DISCOVERY_STALE_TIME_MS`                   |      `24*60*60_000` | `apps/web/src/lib/providerDiscoveryReactQuery.ts:52`                                    |
| `LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS`                |            `10_000` | `apps/web/src/lib/serverReactQuery.ts:12`                                               |
| `LOCAL_SERVERS_DEFAULT_STALE_TIME_MS`                      |             `3_000` | `apps/web/src/lib/serverReactQuery.ts:13`                                               |
| `MAX_HIGHLIGHT_CACHE_MEMORY_BYTES`                         |      `50*1024*1024` | `apps/web/src/lib/syntaxHighlighting.ts:18`                                             |
| `BUFFER_SIZE`                                              |             `2_048` | `apps/web/src/lib/voiceRecorder.ts:49`                                                  |
| `WAVEFORM_EMIT_INTERVAL_MS`                                |                `32` | `apps/web/src/lib/voiceRecorder.ts:51`                                                  |
| `DURABLE_CHECKPOINT_MS`                                    |               `250` | `apps/web/src/lib/voiceRecorder.ts:52`                                                  |
| `NOTIFICATION_SUMMARY_MAX_LENGTH`                          |               `120` | `apps/web/src/notifications/taskCompletion.logic.ts:87`                                 |
| `PROJECT_COMMAND_TERMINAL_COLS`                            |               `120` | `apps/web/src/projectTerminalRunner.ts:14`                                              |
| `PROJECT_COMMAND_TERMINAL_ROWS`                            |                `30` | `apps/web/src/projectTerminalRunner.ts:15`                                              |
| `PROVIDER_UPDATE_INITIAL_REFRESH_DELAY_MS`                 |            `10_000` | `apps/web/src/providerUpdates.ts:13`                                                    |
| `PROVIDER_UPDATE_REFRESH_INTERVAL_MS`                      |       `60*60*1_000` | `apps/web/src/providerUpdates.ts:14`                                                    |
| `PROVIDER_UPDATE_REQUEST_TIMEOUT_MS`                       |          `2*60_000` | `apps/web/src/providerUpdates.ts:17`                                                    |
| `ORCHESTRATION_SYNC_PUBLICATION_INTERVAL_MS`               |                `50` | `apps/web/src/routes/__root.tsx:99`                                                     |
| `MAINTENANCE_EVENT_STALE_MS`                               |         `5*60*1000` | `apps/web/src/routes/_chat.tsx:55`                                                      |
| `MAX_SNAPSHOT_BYTES`                                       |      `16*1024*1024` | `apps/web/src/storageOriginMigration.ts:9`                                              |
| `LOCAL_USER_MESSAGE_RETENTION_MS`                          |            `10_000` | `apps/web/src/storeNormalization.ts:61`                                                 |
| `THREAD_DETAIL_PREWARM_RELEASE_MS`                         |            `10_000` | `apps/web/src/threadDetailPrewarm.ts:10`                                                |
| `THREAD_DETAIL_PREWARM_LIMIT`                              |                 `5` | `apps/web/src/threadDetailPrewarm.ts:11`                                                |
| `THREAD_DETAIL_RETENTION_EVICTION_MS`                      |        `15*60*1000` | `apps/web/src/threadDetailSubscriptionRetention.ts:11`                                  |
| `DEFAULT_THREAD_TERMINAL_HEIGHT`                           |               `280` | `apps/web/src/types.ts:36`                                                              |
| `MAX_TERMINALS_PER_GROUP`                                  |                 `6` | `apps/web/src/types.ts:38`                                                              |
| `REQUEST_TIMEOUT_MS`                                       |            `60_000` | `apps/web/src/wsTransport.ts:157`                                                       |
| `WS_RECONNECT_ATTEMPT_TIMEOUT_MS`                          |             `3_000` | `apps/web/src/wsTransport.ts:158`                                                       |
| `DEFAULT_STREAM_CAPACITY_RETRY_MS`                         |             `1_000` | `apps/web/src/wsTransport.ts:256`                                                       |
| `MAX_STREAM_CAPACITY_RETRY_MS`                             |            `10_000` | `apps/web/src/wsTransport.ts:257`                                                       |
| `DEFAULT_STREAM_DUPLICATE_RETRY_MS`                        |               `250` | `apps/web/src/wsTransport.ts:284`                                                       |
| `MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS`                      |                 `5` | `apps/web/src/wsTransport.ts:285`                                                       |
| `DEFAULT_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_MS`               |               `100` | `apps/web/src/wsTransport.ts:287`                                                       |
| `MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS`             |                `12` | `apps/web/src/wsTransport.ts:288`                                                       |

**522 named numeric declarations/call sites.**

## Production `server.log`: 20 most frequent messages

Read-only scan of `/Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/userdata/logs/server.log`: 329,224 physical lines, 329,224 parsed/missing-message records. Counts group the decoded `message` field exactly, independent of dynamic fields.

| Rank | Message                                               |   Count | Recommendation                                                |
| ---: | ----------------------------------------------------- | ------: | ------------------------------------------------------------- |
|    1 | `stale orchestration synchronization acknowledgement` | 155,108 | Investigate cause; demote if expected, keep incident if fault |
|    2 | `orchestration lifecycle command rejected`            |  28,997 | Keep as incident; collapse repeats                            |
|    3 | `orchestration command received`                      |  24,582 | Remove text log after checkpoint/structured outcome exists    |
|    4 | `orchestration command accepted`                      |  23,659 | Remove text log after checkpoint/structured outcome exists    |
|    5 | `streaming RPC stream exited`                         |  13,824 | Remove text log after checkpoint/structured outcome exists    |
|    6 | `streaming RPC lease released`                        |  13,824 | Remove text log after checkpoint/structured outcome exists    |
|    7 | `Rejected streaming RPC admission.`                   |   6,233 | Keep as incident; collapse repeats                            |
|    8 | `server startup stage started`                        |   5,959 | Keep boot/shutdown summary; remove per-stage success lines    |
|    9 | `server startup stage completed`                      |   5,302 | Keep boot/shutdown summary; remove per-stage success lines    |
|   10 | `orchestration Thread turn page loaded`               |   5,027 | Remove text log after checkpoint/structured outcome exists    |
|   11 | `server shutdown stage started`                       |   3,997 | Keep boot/shutdown summary; remove per-stage success lines    |
|   12 | `server shutdown stage completed`                     |   3,961 | Keep boot/shutdown summary; remove per-stage success lines    |
|   13 | `orchestration synchronization delivery prepared`     |   2,904 | Remove text log after checkpoint/structured outcome exists    |
|   14 | `provider.claude_native_state.resume_prepared`        |   2,544 | Remove text log after checkpoint/structured outcome exists    |
|   15 | `provider runtime journal drain failed`               |   2,275 | Keep as incident; collapse repeats                            |
|   16 | `provider.runtime_event_pump.quarantined_event`       |   2,264 | Keep as incident; collapse repeats                            |
|   17 | `provider.runtime_reconciliation.started`             |   2,209 | Remove text log after checkpoint/structured outcome exists    |
|   18 | `orchestration synchronization subscribed`            |   1,985 | Remove text log after checkpoint/structured outcome exists    |
|   19 | `codex app-server opening thread`                     |   1,976 | Remove text log after checkpoint/structured outcome exists    |
|   20 | `codex app-server thread open resolved`               |   1,972 | Remove text log after checkpoint/structured outcome exists    |

## Hand-checked high-priority decisions

These rows explain boundaries whose outcome is spread across several lines. They cross-reference the companion full site table and are not additional sites in the summary counts. “IDs” here describes the actual emitted record or returned error, rather than whether an ID variable appears in the local statement.

| Flow               | Decision site                                                      | Failure and current surface                                                                                                                                                                                            | IDs in current record                                             | Proposed incident code                                                   |
| ------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Command worker     | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:1556` | Dispatch waits 45,000 ms; queued command is abandoned and failed, while an in-flight command logs warning then keeps waiting at 1569–1590. The warning has command ID and type but no holding command or step.         | command; no holder/hold duration                                  | `COMMAND_DISPATCH_TIMEOUT`                                               |
| Agent / MCP writes | `apps/server/src/agentGateway/mcpTransport.ts:385`                 | Missing caller write authority logs `agent_gateway.caller_turn_inactive`, then returns `GatewayToolError`. The log has caller thread and several turn candidates.                                                      | thread and turn candidates                                        | `CALLER_TURN_INACTIVE`                                                   |
| Agent / MCP writes | `apps/server/src/agentGateway/mcpTransport.ts:436`                 | Caller turn is no longer in active turn IDs; returns `GatewayToolError` without a local log.                                                                                                                           | returned error context contains caller thread and authorized turn | `CALLER_TURN_INACTIVE`                                                   |
| Play / continue    | `apps/server/src/wsRpc.ts:843`                                     | Rejected Play uses `describeRejectedPlay` to enrich `orchestration command rejected` warning. Its two diagnostic reads use `Effect.catch` to substitute `Option.none()`, so missing context can hide the failed check. | lifecycle log context; diagnostic read failure has none           | `PLAY_REJECTED` / `PLAY_REJECTION_CONTEXT_MISSING`                       |
| Socket connect     | `apps/web/src/wsTransport.ts:793`                                  | Attempt races connection against 3,000 ms timer; raw client rejection is consumed at 797, timeout rejects the promise at 802. No handshake phase or duration is logged here.                                           | none                                                              | `WS_HANDSHAKE_SLOW`                                                      |
| Socket connect     | `apps/web/src/wsTransport.ts:594`                                  | RPC deadline returns `WsTransportRequestInterruptedError` with `WS_REQUEST_TIMEOUT` and method, but no thread/turn/command/connection ID in this error.                                                                | none                                                              | `WS_REQUEST_TIMEOUT`                                                     |
| Socket connect     | `apps/server/src/wsRequestAdmission.ts:96`                         | Class capacity rejection returns `WsRpcError`, increments a rejection counter, and sets a retry delay of 250 ms. The three class caps are control 16, standard 12, expensive read 2.                                   | client ID is available, error has no trace IDs                    | `RPC_REQUEST_CAPACITY_EXCEEDED` / `RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED` |
| Socket connect     | `apps/server/src/wsStreamAdmission.ts:89`                          | Duplicate stream returns `STREAM_DUPLICATE_SUBSCRIPTION`; capacity at 105 returns `STREAM_CAPACITY_EXCEEDED`. Both are warning logged at 139 and may call a diagnostic callback.                                       | optional thread ID; no connection/command                         | existing wire codes                                                      |
| Provider delivery  | `apps/server/src/provider/providerRuntimeEventPump.ts:171`         | No quarantine callback silently skips persistence; failed quarantine persistence retries with warning at 183.                                                                                                          | provider/event ID in warning; no thread/turn                      | `QUARANTINE_PERSISTENCE_UNAVAILABLE` / `QUARANTINE_PERSISTENCE_RETRY`    |
| Provider delivery  | `apps/server/src/provider/providerRuntimeEventPump.ts:224`         | Permanent event failure persists quarantine, logs error at 236, and degrades health. Transient failure retries at 249, with warning only when `shouldLogRetry` is true.                                                | event, thread, turn in emitted event log                          | `INTENT_QUARANTINED` / `PROVIDER_EVENT_RETRY`                            |
| Provider delivery  | `apps/server/src/provider/providerRuntimeEventPump.ts:279`         | Failed event stream logs error and restarts after delay; an unexpectedly successful end logs warning and restarts.                                                                                                     | provider and attempt, no thread/turn                              | `PROVIDER_EVENT_STREAM_FAILED` / `PROVIDER_EVENT_STREAM_ENDED`           |

The stream cap `MAX_STREAMS_PER_RPC_CLIENT` is imported from `@penkra/contracts`; its defining numeric value is outside the requested three source trees. `WS_REQUEST_CLASS_LIMITS` object values are listed in the limits table above. `Effect.catchAll` and `Effect.retry` have zero direct calls in this scoped source; recovery also uses `Effect.catch`, `Effect.catchCause`, promise `.catch`, and explicit recursive retry loops.
