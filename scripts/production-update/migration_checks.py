#!/usr/bin/env python3
"""Exercise migration preflight and the no-backup log failure gate."""
import pathlib
import sqlite3
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

import helper


def check():
    with tempfile.TemporaryDirectory(prefix='penkra-migration-check-') as directory:
        root = pathlib.Path(directory)
        userdata, update = root/'userdata', root/'update'
        (userdata/'logs').mkdir(parents=True)
        (userdata/'state.sqlite.backups').mkdir()
        update.mkdir()
        for name in ('desktop.log', 'server.log'):
            (userdata/'logs'/name).write_text('')
        database = userdata/'state.sqlite'
        with sqlite3.connect(str(database)) as db:
            db.execute('CREATE TABLE effect_sql_migrations(migration_id INTEGER)')
            db.execute('INSERT INTO effect_sql_migrations VALUES (214)')
        helper.configure(update, root/'candidate.app', root/'installed.app', userdata)
        def candidate(value): return lambda *a, **k: SimpleNamespace(stdout=str(value)+'\n')
        with patch.object(helper.os, 'statvfs', return_value=SimpleNamespace(f_bavail=0, f_frsize=4096)):
            try: helper.space_preflight()
            except RuntimeError as error: assert 'not enough free disk space' in str(error)
            else: raise AssertionError('insufficient free space was accepted')
        with patch.object(helper.os, 'statvfs', return_value=SimpleNamespace(f_bavail=1000000, f_frsize=4096)):
            helper.space_preflight()
        wal, shm = pathlib.Path(str(database)+'-wal'), pathlib.Path(str(database)+'-shm')
        wal.write_bytes(b'w' * 1000); shm.write_bytes(b's' * 2000)
        required = 4 * (database.stat().st_size + wal.stat().st_size + shm.stat().st_size)
        with patch.object(helper.os, 'statvfs', return_value=SimpleNamespace(f_bavail=required-1, f_frsize=1)):
            try: helper.space_preflight()
            except RuntimeError as error: assert 'not enough free disk space' in str(error)
            else: raise AssertionError('WAL and shared-memory bytes were not counted')
        wal.unlink(); shm.unlink()
        with patch.object(helper, 'verify_db', return_value=SimpleNamespace(stdout='{"latestMigrationId":214}')):
            with patch.object(helper, 'cmd', candidate(215)):
                helper.migration_preflight()
            with patch.object(helper, 'cmd', candidate(214)):
                helper.migration_preflight()
            with patch.object(helper, 'cmd', candidate(213)):
                try: helper.migration_preflight()
                except RuntimeError as error: assert 'older' in str(error)
                else: raise AssertionError('older candidate was accepted')
        with patch.object(helper, 'verify_db', return_value=SimpleNamespace(stdout='{"migrationCount":214}')):
            try: helper.migration_preflight()
            except RuntimeError as error: assert 'migration ID is unavailable' in str(error)
            else: raise AssertionError('missing migration ID was accepted')
        monitor = helper.Monitor(helper.boundaries())
        monitor.launch_time = time.time()-1
        try:
            (userdata/'logs/server.log').write_text('backupOutcome=skipped-insufficient-space\n')
            try: monitor.scan()
            except RuntimeError as error: assert 'without a backup' in str(error)
            else: raise AssertionError('missing-backup warning was accepted')
            assert monitor.unsafe_no_backup and (update/'migration-without-backup.json').is_file()
        finally: monitor.close()
    print('migration preflight and no-backup warning checks passed')


if __name__ == '__main__':
    check()
