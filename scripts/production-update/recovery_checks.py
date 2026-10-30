#!/usr/bin/env python3
"""Exercise database recovery branch routing on disposable SQLite files.

This isolates the helper's choices; the marked restore is simulated here and
must also be tested with the packaged restore command in the full rehearsal.
"""
import json
import pathlib
import shutil
import sqlite3
import tempfile

import helper


def contents(path):
    with sqlite3.connect(str(path)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return connection.execute("SELECT value FROM fixture").fetchone()[0]


def check():
    with tempfile.TemporaryDirectory(prefix="penkra-update-recovery-") as directory:
        root = pathlib.Path(directory)
        update = root / "update"
        userdata = root / "userdata"
        backups = userdata / "state.sqlite.backups"
        update.mkdir()
        backups.mkdir(parents=True)
        database = userdata / "state.sqlite"
        with sqlite3.connect(str(database)) as connection:
            connection.execute("CREATE TABLE fixture(value TEXT)")
            connection.execute("INSERT INTO fixture VALUES ('before')")
            connection.execute("CREATE TABLE effect_sql_migrations(migration_id INTEGER)")
            connection.execute("INSERT INTO effect_sql_migrations VALUES (215)")
        backup = backups / "fresh.sqlite"
        shutil.copyfile(database, backup)
        helper.configure(update, root / "candidate.app", root / "installed.app", userdata)
        fingerprint = helper.scratch_database_fingerprint()
        assert fingerprint['integrity'] == 'ok' and fingerprint['migration_id'] == 215
        event = {"databasePath": str(database), "backupPath": str(backup),
                 "sourceVersion": "v214", "targetVersion": 215}
        original_verify, original_cmd = helper.verify_db, helper.cmd
        try:
            helper.verify_db = lambda path, app=None: contents(path)
            helper.recover_database_after_failed_launch(None)
            assert contents(database) == "before"
            with sqlite3.connect(str(database)) as connection:
                connection.execute("UPDATE fixture SET value='after'")
            assert helper.scratch_database_fingerprint()['dump_sha256'] != fingerprint['dump_sha256']
            helper.recover_database_after_failed_launch(event)
            assert contents(database) == "before"
            assert helper.scratch_database_fingerprint() == fingerprint
            assert contents(update / "failed-db" / "state.sqlite") == "after"
            assert contents(backup) == "before"
            marker = pathlib.Path(str(database) + ".migration-recovery.json")
            marker.write_text(json.dumps(event))
            with sqlite3.connect(str(database)) as connection:
                connection.execute("UPDATE fixture SET value='interrupted'")
            calls = []
            def simulated_restore(args, env=None, gate=True):
                calls.append(args)
                shutil.copyfile(backup, database)
                marker.unlink()
            helper.cmd = simulated_restore
            helper.recover_database_after_failed_launch(event)
            assert calls and calls[0][-1] == str(database)
            assert contents(database) == "before" and not marker.exists()
            marker.write_text(json.dumps({**event, "backupPath": str(backups / "other.sqlite")}))
            try:
                helper.recover_database_after_failed_launch(event)
            except RuntimeError as error:
                assert "does not match" in str(error)
            else:
                raise AssertionError("mismatched marker was accepted")
            assert marker.exists() and len(calls) == 1
        finally:
            helper.verify_db, helper.cmd = original_verify, original_cmd
    print("recovery branch routing checks passed (marked restore simulated)")


if __name__ == "__main__":
    check()
