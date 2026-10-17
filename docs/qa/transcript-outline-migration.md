# Transcript outline migration rehearsal

2026-10-17, migration 209. No Production database repair or app replacement.
The canonical snapshot was taken while Production was stopped, under the database
lifecycle lock using SQLite VACUUM INTO. Production was then reopened unchanged.
All migration and measurement work below used that offline copy.

## Ordering evidence

The first rehearsal rejected 53 original turn markers after their provider work;
it rolled back both pending migrations without changing the copy's rows. The
operator amended P4.1: position every turn marker immediately before its first
provider item, or after its last user item when there is no provider work.
Non-turn rows retain relative order; existing markers retain rowid, source,
status, timing and timestamps. A focused late-marker reproduction failed before
the amendment was implemented, then passed. Duplicate markers still fail and roll
back the entire migration. Missing markers receive unknown timing, never inferred
durations.

## Successful copy rehearsal

Source: 590 threads, 705,491 items, latest migration 207. Pending migrations 208
and 209 committed together. Migration 209 reported:

| Measure                                            |     Result |
| -------------------------------------------------- | ---------: |
| Runtime warnings removed                           |     30,500 |
| Turnless items attached to preceding turn          |      4,711 |
| Genuine turnless items remaining                   |         20 |
| Missing turn markers inserted                      |     35,281 |
| Existing markers repositioned across non-turn rows |        112 |
| Invalid marker groups                              |          0 |
| Invalid sequence groups                            |          0 |
| Reordered non-turn rows                            |          0 |
| Migration body                                     | 134,714 ms |
| Combined transaction including commit              | 136,718 ms |

112 is the measured reposition count, not the plan's estimate of 53 late markers.
The amended rule positions **all** markers, rather than only repairing markers
that follow their own work; a marker already before its work can also move across
intervening rows. No non-turn relative order changed.

All 590 threads and all 1,060 per-thread user/text count groups matched before and
after. Database allocation: 834,865 pages × 4,096 bytes, zero free pages.
The schema audit found no sequence-valued columns outside thread_items; source
audit found no persisted transcript-sequence references requiring rewriting.
FTS internal integrity passed, and eligible document IDs matched in both directions
(zero extra, zero missing). The migration keeps existing rowids and does not
update indexed text/status/kind.
Canonical offline `penkra-database verify` passed on SQLite 3.53.3: 22 tables,
199 recorded migrations, 590 threads and 710,272 resulting items.

## Outline query measurement

Actual SQL, including final-answer and has-steps lookups for every marker in the
50-row outline page, on the three largest threads after migration:

| Thread                                 | Total items | Markers on page | Complete read |
| -------------------------------------- | ----------: | --------------: | ------------: |
| agent-dc98d144527b88506ed8df45e458827e |      66,514 |              33 |       5.83 ms |
| 78be0300-d47e-472f-b9a0-23afaf6abb0e   |      55,760 |              27 |       2.19 ms |
| agent-ed372a7c0ac95dcf8d4f315f305b0ccd |      55,370 |              11 |       1.49 ms |

These are single measurements of the planned SQL, not the unfinished RPC/client
implementation, end-to-end UI timings, or a cold-storage percentile guarantee.
Maintenance scans and writes exceeded the 50 ms interactive target and are
included in the full migration runtime above, not hidden as interactive results.

The implemented `listThreadItemsPage` was subsequently measured through the
canonical NodeSqliteClient under the lifecycle lock on this same offline copy:

| Total items | Outline rows | Markers | Actual function | First turn details |
| ----------: | -----------: | ------: | --------------: | -----------------: |
|      66,514 |           50 |      33 |        20.94 ms |  1.13 ms (12 rows) |
|      55,760 |           50 |      27 |         6.40 ms |   0.20 ms (2 rows) |
|      55,370 |           50 |      11 |         9.66 ms |  1.22 ms (50 rows) |

All three page functions are below 50 ms. This is not a WebSocket/UI latency
measurement or percentile claim. The separate all-history query used only to
select the three largest fixture threads took 626 ms and was logged by the
bounded-query diagnostics; it is not part of the interactive page-read function.

Focused migration tests: 24/24 pass. Workspace format/lint/typecheck pass:
0 lint errors (865 warnings), 11 successful typecheck tasks. An initial test-only
possibly-undefined assertion value was corrected before the passing typecheck.
