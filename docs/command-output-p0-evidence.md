# Command-output freeze: local Production-copy evidence

2026-10-14. P0 in the repository TODO is the design authority. No public release or version change.

## Scope and mechanism

The observed freeze was synchronous SQLite work on an ever-growing command-output item,
with full trigram reindexing on every delta. Other threads waited behind this shared JS thread.
The corrected path writes command output only into the activity's bounded UTF-8 head/tail window.
Only final user/assistant text is indexed. Provider queue arrays drain in order; each consecutive
delta run commits once and publishes once per affected thread. Non-delta lifecycle handling stays
on its existing path. There is no timer, fixed batch-size policy, worker or watchdog.

## Migration rehearsal

Production was closed and had no database owner. The supported lifecycle-locked maintenance
snapshot used SQLite 3.53.3, a read-only source and VACUUM INTO. Snapshot integrity passed.
Only the scratch copy was migrated and measured.

- 589 threads, 672,850 items and 94,932 user/assistant messages before and after migration 207.
- Every conversation fidelity signature matched: text, creation time, origin, available sender,
  attachments and references. Attachments: 673; mentions: 256; steered messages: 6,495.
- Tool cleanup: 0 invalid streaming rows; 15 oversized tool text rows shortened to the frozen
  10,000-character migration limit. No output was backfilled.
- Filtered index rebuild: 12,714.6 ms; allocated index bytes 235,278,336 → 199,561,216.
- Both indexed-document set differences were zero. FTS internal integrity-check passed.
- Database integrity-check passed; foreign-key check empty; 778,380 pages, 8,659 free pages.
  The offline whole-database scans exceed the interactive query target; they are not UI timings.

An initial, isolated in-memory investigation disproved the original split-trigger ordering claim:
editing `alpha beta` to `alpha gamma` lost `alpha` if insert ran before delete. The operator revised
the plan to one ordered update trigger before migration 207 was implemented. Index membership is
checked through `_docsize`, not an external-content table's unfiltered COUNT.

## Required P0.5 measurements

The harness calls the actual `applyProviderDeltaRun`, SQL client and publisher on the migrated
Production copy. Each array below is a supplied measurement input, not a production batch policy.
Transaction duration surrounds the real SQL client's transaction effect. No test suites ran.

| Input                                             | Total ms | Transactions | Slowest transaction ms |
| ------------------------------------------------- | -------: | -----------: | ---------------------: |
| 5,242,880 output bytes, 4 KiB deltas, arrays of 1 | 1,160.35 |        1,280 |                   8.22 |
| Same output, arrays of 50                         |    44.63 |           26 |                   2.82 |
| Same output, arrays of 500                        |    28.59 |            3 |                  14.39 |
| 20,000 assistant characters, 60-character deltas  |   253.35 |          334 |                   4.18 |

For each tool case, batch invalidations equalled transaction count. The activity data was 10,614
UTF-8 bytes, including metadata; total observed output bytes were exact. The retained head and tail
matched a single-pass window, with Unicode boundaries intact. Output arriving before item start
survived the start event, and the same window survived completion. Tool status remained running
through deltas and became done only on its item completion. Tool text remained the command.

For assistant text, the row was absent from `_docsize` while streaming and present exactly once
after completion; the full 20,000 characters were preserved.

These are write-path measurements, not end-to-end provider or visual acceptance. The operator
checks running/completed command-output display in Production. Formatting, lint (0 errors) and
workspace typecheck passed. Existing unrelated reviewer and test edits were not included.
