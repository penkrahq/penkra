# Hidden Play recovery messages and Stop presentation

Version remains 0.14.4. This bundle is prepared for review; it has not been signed or installed.

The shared `MessageOrigin` and `SendingMessageOrigin` schemas now accept `recovery`. Play sends its existing prompt with this origin. Provider input passes its text through literally, and reconstruction retains that text and origin. The provider still receives the instruction.

Canonical transcript mapping, the ChatView message/auto-follow projections and visible queue exclude recovery messages. The user-turn marker returns no marker for recovery. Server transcript reads, gateway transcript packing/pagination, message counts, transcript search and space search exclude them. Thread preview/latest-user rollup writes skip recovery, including the rollup recomputation after failed-message removal. Shared latest-user summary metadata skips them too.

Migration 206 retags only user items with the exact Play prompt and `origin._tag = user`; a trailing space, different text or agent authorship is retained. It preserves rows and repairs affected thread previews/latest-user timestamps. Frozen migration-203 schemas are untouched. No Production database was opened or changed.

The Stop button's stopping state remains disabled while provider confirmation is pending. It uses the same fixed 26px grey spinner circle as sending. “Stopping…” remains only its accessibility label. The provider-confirmation behavior is unchanged.

## Origin consumer audit

The pre-edit audit is `/tmp/penkra-recovery-origin-consumers.txt`; the follow-up inventory is `/tmp/penkra-recovery-origin-final-consumers.txt`. Searches covered `MessageOrigin`, `SendingMessageOrigin`, `decodeUserItemData`, `.origin`, `origin._tag`, exhaustive branches and `Match.tag`, excluding build output and frozen migrations. There are no exhaustive origin switches or `Match.tag` consumers. Unrelated URL, voice and skills origins were excluded.

| Consumers | Treatment |
| --- | --- |
| contracts/messageOrigin.ts, cleanCore.ts, orchestration.ts | Additive shared schema; canonical user and queued-message schemas inherit it. |
| shared/userItemData.ts | Strict canonical decoding accepts the additive origin. |
| cleanCore/userItemAdmission.ts, sendPayload.ts, threadQueue.ts | Keep recovery origin and payload for real delivery, cohorts and queues. |
| cleanCore/ThreadSender.ts | Agent-owned steering remains agent-only; failed-removal rollups exclude recovery. |
| cleanCore/threadStore.ts, threadList.ts, ThreadReads.ts | Exclude from visible rollups, searches, public transcript and message counts. |
| provider/providerTurnInput.ts, reconstructedContinuation.ts | Pass text through and retain actual provider history. |
| agentGateway/threadSummary.ts | Filter before packing, pagination and total message count. |
| web/components/chat/threadItemMappers.ts, ChatView.tsx | Filter before transcript rendering, message projection, auto-follow counts and queue display. |
| web/components/chat/userTurnMarker.ts | No recovery marker. |
| shared/threadSummary.ts | Exclude from latest-user metadata. |
| web/storeNormalization.ts | Generic origin carry/equality works unchanged; only agent attribution reads senderThreadId. |
| web/components/chat/MessagesTimeline.tsx | Agent-specific sender rendering stays agent-only; canonical recovery rows never reach it. |
| web/components/timelineHeight.ts, web/types.ts | Type consumers; canonical recovery rows never enter measurement/rendering. |
| persistence/rehearsalConversationFidelity.ts | Operational fidelity keeps retained history; not a public transcript display. |
| frozen migration schemas | Unchanged; new migration performs exact retagging. |

Boundary for review: task-completion notifications follow the actual newest settled turn item. They do not count the recovery message. This bundle removes the hidden prompt from user-message metadata, but does not suppress completion notifications for assistant work performed by the recovered turn. That would be a separate behavior decision.

## Verification

- Root `bun typecheck`: 11/11 successful; final pass after all edits took 11.94 seconds.
- `providerTurnInput.test.ts` + migration 206: 8 cases passed.
- `threadItemMappers.test.ts` + `ButtonSend.test.tsx`: 18 cases passed.
- `reconstructedContinuation.test.ts` + expanded migration 206: 5 cases passed (literal history retained, exact retagging, row preservation and rollup repair).
- Only the bundle's files were formatted with repository oxfmt.

The OpenCode plugin and Connection/model-line implementation designs were withdrawn. Plugin edits were reverted; Connection/model source was never edited. The controlled scratch plugin experiment is not installed or shipped.

The sole approved cleanup path `~/Penkra/.penkra/userdata/updates/20261013-063122-947351/Penkra.app` was absent when checked. Nothing was deleted; 0 bytes were freed. No alternative path was deleted.
