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
        with patch.object(helper, 'cmd', candidate(215)), patch.object(helper.os, 'statvfs', return_value=SimpleNamespace(f_bavail=0, f_frsize=4096)):
            try: helper.migration_preflight()
            except RuntimeError as error: assert 'needs' in str(error) and '0 available' in str(error)
            else: raise AssertionError('migration without space was accepted')
        with patch.object(helper, 'cmd', candidate(214)), patch.object(helper.os, 'statvfs', return_value=SimpleNamespace(f_bavail=0, f_frsize=4096)):
            helper.migration_preflight()
        with patch.object(helper, 'cmd', candidate(213)):
            try: helper.migration_preflight()
            except RuntimeError as error: assert 'older' in str(error)
            else: raise AssertionError('older candidate was accepted')
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
