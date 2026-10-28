# Main folder visibility, 2026-10-13

Production 0.14.4, backend PID 13550, server instance
`40f9190b-7c09-4ae4-9ef1-f5921b3d9e0f`: authenticated read-only WebSocket
queries returned 96 undeleted Main threads. Page one held 50 archived rows;
page two held 29 archived and 17 active rows. No live database was opened.

The sidebar filters archived rows after fetching. Its folder hasContent decision
uses those filtered rows, so the archive-only first page prevents expansion and
hides the pagination observer. Native Computer Use verified Main had no child
rows and clicking it did not expand. Binding by running display name succeeded
after path-bound Computer Use returned a stale window and noWindowsAvailable.

The backend listThreads query now excludes archived and deleted rows before its
limit and keyset cursor. The duplicate listFolderThreads entry point and the
includeArchived branch are removed; the desktop folder API uses the same active
listing. Archive listing, direct thread lookup, sort order and cursor shape stay
unchanged. No data migration, client pagination workaround, or version change.

Regression: 51 archived rows sort before 51 active rows, plus a deleted row.
Before correction the first returned id was archive-heavy-000 (test failed).
After correction pages contain 50 active rows and then one, without duplicates;
an archive-only folder returns no rows and no cursor, and direct lookup still
finds its stored archived thread.

Source verification: 43 tests passed across threadList, threadSearch, archive,
and desktopThreadCommands. Full bun fmt, bun lint (518 warnings, zero errors),
and bun typecheck (11 successful tasks) passed.

## Local Production installation

The normal build script produced a complete Developer-ID-signed 0.14.4 app with
the pinned required Apps 0.2.10 bundle. Deep strict signature verification passed.
This is a local non-notarized build; no public release, version bump or security
protection change. Its ASAR SHA256 is
`65629b09fda2e918597f4eb8d02f2411e4e6d10cf9dadb28dcc29cba43c53fd0`.

The first detached updater attempt failed before mutation because Homebrew Codex
0.157.1 rejected its configured model. The successful prior update used the
standalone 0.161.0 executable under penkra-rehearsal; using that same executable
started the supported updater without changing model settings. OpenAI Docs was
used to check CLI configuration options during this investigation.

Update evidence: `~/Penkra/.penkra/updates/20261013-084020-334346/`.
The installed archive hash matches the candidate. New desktop PID 26873, backend
26888, server instance `d377d225-b2f7-4dfb-a1f8-5782ed78b5d5`, port 60651.
Fresh `/status` returned version 0.14.4 and migration status ok. The authenticated
active-thread RPC returned 17 rows, zero archived rows, nextCursor null. The
separate archive RPC returned 50 archived rows with a next cursor.

Native post-install inspection after unlock confirmed Penkra → Main displays
the first five active rows and its Show more control. The selected "Let's take
over the discussion from" route displayed its real conversation and composer,
not an empty or loading pane. AX and screenshot both confirmed these results.
Concurrent operator interaction prevented two Show more clicks; expansion of
the remaining rows was not validated. The backend independently returned all
17 active rows. No composer text was changed or message sent by this QA.
Computer Use AX calls still took up to 28.77 seconds: do not interpret successful
folder visibility as a fix for all interaction or sending issues.

The one-shot updater exited zero with UPDATE OK. Its closed-database integrity
check and exact installed hash verification passed; no database recovery was
required. Temporary empty build stages were removed, and this task's completed
build stage and DMG/ZIP outputs were moved recoverably to Trash. The updater's
prior installed bundle and database backups remain untouched.
