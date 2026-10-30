#!/usr/bin/env python3
"""Exercise the packaged marked-restore command against disposable SQLite data."""
import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile

import helper


def value(path):
    with sqlite3.connect(str(path)) as connection:
        assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        return connection.execute('SELECT value FROM fixture').fetchone()[0]


def main(candidate):
    candidate = pathlib.Path(candidate).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='penkra-packaged-restore-') as directory:
        root = pathlib.Path(directory).resolve()
        update, userdata = root / 'update', root / 'userdata'
        backups = userdata / 'state.sqlite.backups'
        update.mkdir()
        backups.mkdir(parents=True)
        database = userdata / 'state.sqlite'
        with sqlite3.connect(str(database)) as connection:
            connection.execute('CREATE TABLE fixture(value TEXT)')
            connection.execute("INSERT INTO fixture VALUES ('before')")
        backup = backups / ('state.sqlite.pre-migration-v214-to-v215-20261029T120000000Z-'
                            '12345678-1234-4123-8123-123456789abc.sqlite')
        shutil.copyfile(database, backup)
        event = {'databasePath': str(database), 'backupPath': str(backup),
                 'sourceVersion': 'v214', 'targetVersion': 215}
        marker = pathlib.Path(str(database) + '.migration-recovery.json')
        marker.write_text(json.dumps({**event, 'resumeAttempts': 0}))
        prior = userdata / 'state.sqlite.failed-migration-20260101T000000000Z-old'
        stale_restore = userdata / 'state.sqlite.old.restore'
        prior.write_text('old failed bundle')
        stale_restore.write_text('old restore artifact')
        with sqlite3.connect(str(database)) as connection:
            connection.execute("UPDATE fixture SET value='interrupted'")
        helper.configure(update, candidate, root / 'installed.app', userdata)
        helper.recover_database_after_failed_launch(event)
        assert value(database) == 'before' and value(backup) == 'before'
        assert not marker.exists()
        retained = update / 'retained-migration-artifacts'
        assert (retained / prior.name).read_text() == 'old failed bundle'
        assert (retained / stale_restore.name).read_text() == 'old restore artifact'
        failed = list(userdata.glob('state.sqlite.failed-migration-*'))
        assert len(failed) == 1 and value(failed[0]) == 'interrupted'
    print('packaged marked restore preserved interrupted database and restored the backup')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: packaged_restore_check.py <candidate.app>')
    main(sys.argv[1])
