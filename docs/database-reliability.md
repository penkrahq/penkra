# Penkra database reliability

This is the contributor and operator contract for Penkra's local SQLite database. It is not part of
the public App API.

## Ownership model

Each production installation and each numbered development slot has one state root, one embedded
backend, and one `state.sqlite`. Numbered Dev slots share source watchers and local web services but
do not share desktop profiles, embedded backends, lifecycle locks, or databases.

The embedded backend owns its database for its complete process lifetime. It first acquires
`state.sqlite.lifecycle-lock`, then opens one SQLite connection, requires SQLite 3.51.3 or newer,
sets `locking_mode=EXCLUSIVE`, enables WAL, and proves the exclusive lock with a transaction before
running migrations or application work. A second Penkra backend targeting the same canonical path
must fail without opening the database.

The lifecycle directory is a Penkra process-ownership guard. Generic SQLite programs do not honor
it. SQLite's own exclusive lock is the second boundary and must remain active until the owning
connection closes.

Do not open and close any additional file descriptor for `state.sqlite` after SQLite acquires that
lock. Traditional POSIX record locks are process-associated: closing a second descriptor for the
same file can release the locks held by the still-live SQLite connection. Permission repair for the
database and pre-existing sidecars therefore happens before the connection opens. A subprocess
regression test—not a second connection in the same process—proves the lifetime boundary.

## Supported operations

While Penkra is running, inspect state through registered Penkra diagnostics or backend APIs. Never
open the database with `sqlite3`, a database browser, an IDE extension, shell Node, Bun, or a custom
script. A connection described as read-only can still participate in WAL recovery and close-time
checkpoint cleanup.

After every Penkra process for the exact state root has stopped, verify with:

```text
penkra-database verify /absolute/path/to/state.sqlite
```

The command uses Penkra's bundled maintenance implementation. It refuses a live lifecycle owner,
requires the safe SQLite baseline, takes SQLite's exclusive lock, runs `integrity_check` and
`foreign_key_check`, and validates Penkra's migration lineage and event/projection invariants.

Migration snapshots use `VACUUM INTO`. Future online or periodic snapshots must use SQLite's Online
Backup API. A raw copy of a live `state.sqlite` is unsupported because committed pages may still
exist only in `state.sqlite-wal`.

Migration restore remains explicit and offline:

```text
penkra-restore-migration-backup /absolute/path/to/state.sqlite
```

Restore validates both physical SQLite integrity and Penkra semantic integrity before replacing the
database. There is no automatic `.recover` path: physical recovery can silently discard the
authoritative event history while leaving a queryable file.

## Fatal behavior

`SQLITE_IOERR`, `SQLITE_CORRUPT`, and `SQLITE_NOTADB` poison the active connection. The backend emits
the stable `FatalSqliteDatabaseError` marker and exits without further database access. The desktop
recognizes that marker, stops automatic restart attempts, and directs the operator to logs and an
offline verified recovery. An unsupported SQLite runtime is also non-retryable.

## Required QA matrix

Use disposable state roots unless a manual installed-profile check explicitly requires otherwise.
Never induce concurrency against a valued database.

- start and cleanly stop a fresh database;
- restart after committed Thread activity and verify continuity;
- launch two different numbered Dev slots concurrently;
- attempt a duplicate backend against one root and prove lifecycle-lock refusal;
- attempt a second SQLite connection while the backend owns WAL and prove `database is locked`;
- rebuild/restart the embedded backend while a provider turn is active and prove the old PID exits
  before the new owner acquires the lock;
- terminate the backend abruptly, reopen it, and verify WAL recovery;
- take and validate a migration snapshot;
- reject a physically valid database whose projections exist without authoritative events;
- reject a projection sequence ahead of the event log;
- reject SQLite earlier than 3.51.3;
- recognize corruption once and prove the desktop does not enter its normal restart loop;
- run offline verification after the process tests and confirm physical and semantic health.

Manual completion QA must start a fresh Penkra Dev instance, create and continue a Thread, close the
app cleanly, reopen it, and confirm the Thread persists. Database health is verified only after that
instance is fully stopped.

## SQLite references

- [How SQLite databases become corrupt](https://www.sqlite.org/howtocorrupt.html), especially the
  POSIX `close()` lock-cancellation behavior in section 2.2.
- [SQLite WAL and the WAL-reset bug](https://www.sqlite.org/wal.html), fixed in 3.51.3 and later.
- [SQLite locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode), including the
  lifetime behavior of `EXCLUSIVE` mode.
- [SQLite online backup API](https://www.sqlite.org/backup.html) for future live snapshot work.
