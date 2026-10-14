# Connection/model transcript line investigation, 2026-10-13

Report only at `fd7ece4d0`. No product changes or Production database access.

## Emitter removal

`1dc506c87` (Step 12 en) deleted `apps/server/src/orchestration/decider.ts`, including the still-live activity creation. Its parent has `Connection changed to ...` at line 204 and `Model changed to ...` at line 236. The v0.14.3 implementation has these summaries at lines 1633 and 1667. `git log -S 'Connection changed to'` confirms the deletion commit.

The whole live apps/packages search for `connection-changed|model-changed`, excluding migrations and dist, now finds only web rendering and test consumers; no server producer remains.

## Current admission

A composer pick updates the draft's `connectionSelectionByProvider` and model selection (`composerDraftActions.ts:870-938`, synced by `composerDraftSync`). It does not switch the thread's current provider state.

Actual selection is accepted at turn admission in `orchestration/Layers/ProviderThreadSwitchCoordinator.ts`: resolve the requested selection, copy/materialize native state for a changed account as needed, then call `commitThreadTurnSelection` in a transaction (`:230-244`). `cleanCore/threadTurnSelection.ts:24-32` persists connection_id, model, model_options, native_state_id and provider_session_id together, plus runtime_mode and updated_at. No switch notice item is written. `provider/admittedThreadRuntime.ts:53-65` rejects a changed Connection outside turn admission. ThreadLifecycle handles thread creation/lifecycle, not a replacement switch-line emitter.

## Renderer still works

A diagnostic passed canonical `kind=notice` items with data `{tone:'info',kind:'connection-changed'|'model-changed',summary,payload:{}}` through `threadItemsToTimelineEntries`, then rendered `TimelineWorkEntryRow` with react-dom/server.

Both retained their label and emitted the expected `data-transcript-selection-event` attribute. Log: `/tmp/penkra-connection-render-probe.log`. `workLog.ts:38-42` recognizes the activity kinds and `TimelineWorkEntryRow.tsx:675-690` renders the designed separator. The existing MessagesTimeline test at lines 267-301 covers these same user-visible labels.

## Historical lines do not survive the normal migration path

There is an additional loss before the emitter deletion: migration 176's remaining-activity import (`176_CleanCoreSchemaAndBackfill.ts:398-433`) has an explicit allowed-kind list that excludes both switch kinds. Neither is a tool activity. Normal decider-created switch activities therefore never become thread_items. Migration 201 subsequently drops projection_thread_activities.

An isolated in-memory diagnostic ran through migration 175, seeded one ordinary connection-changed and one model-changed projection activity, then ran 176. Before: two activities. After: zero canonical items. Log: `/tmp/penkra-connection-migration-probe.log`. No production or native provider database was used.

The allowlist omission originates in `cb85c5280`, which introduced migration 176. A separately existing equivalent notices row would follow the notice import, but that is not the ordinary decider activity path exercised here. The renderer can display an old switch line only if a canonical item actually remains; the normal migration does not retain it. This report does not invent historical labels or a recovery source after the old table was dropped.

No fix is included; the operator/reviewer decides the replacement writer and any historical restoration policy.
