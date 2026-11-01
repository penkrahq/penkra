#!/usr/bin/env python3
"""Check that failed database preflight relaunches before final reporting."""
import pathlib
import plistlib
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

import helper


def check():
    with tempfile.TemporaryDirectory(prefix='penkra-preflight-check-') as directory:
        root = pathlib.Path(directory)
        candidate, installed = root/'candidate.app', root/'installed.app'
        (candidate/'Contents/Resources').mkdir(parents=True)
        installed.mkdir()
        with (candidate/'Contents/Info.plist').open('wb') as output:
            plistlib.dump({'CFBundleIdentifier': 'com.penkra.app'}, output)
        (candidate/'Contents/Resources/app.asar').write_bytes(b'candidate')
        update, userdata = root/'update', root/'userdata'
        update.mkdir(); userdata.mkdir()
        helper.configure(update, candidate, installed, userdata)
        class FakeMonitor:
            launch_time = 123.0
            def __init__(self, bounds): pass
            def ready(self, app, expected, bounds):
                assert app == installed and expected == '0.14.6'
                return 10, 11, {'migration': {'status': 'ok'}}
            def close(self): pass
        def fake_command(args, env=None, gate=True):
            if args[0] == '/usr/bin/xattr':
                return SimpleNamespace(returncode=1, stdout='')
            return SimpleNamespace(returncode=0, stdout='Authority=Developer ID Application: test')
        events = []
        def check_space(): events.append('space')
        def stop(): events.append('quit')
        def fail_verify(*args):
            events.append('verify')
            raise RuntimeError('database verification failure')
        with patch.object(helper, 'note'), patch.object(helper, 'cmd', fake_command), \
             patch.object(helper, 'version', return_value='0.14.6'), \
             patch.object(helper, 'sha', return_value='hash'), \
             patch.object(helper, 'boundaries', return_value={}), \
             patch.object(helper, 'watcher_preflight'), patch.object(helper, 'space_preflight', side_effect=check_space), patch.object(helper, 'quit_all', side_effect=stop), \
             patch.object(helper, 'migration_preflight', side_effect=fail_verify), patch.object(helper, 'Monitor', FakeMonitor), \
             patch.object(helper, 'report', side_effect=AssertionError('worker reported before exiting')):
            result = helper.main()
        assert result[0] == 'preflight' and result[1:3] == (10, 11)
        assert result[5]['oldversion'] == '0.14.6' and result[6] == 123.0
        assert 'database verification failure' in result[5]['reason']
        assert events == ['space', 'quit', 'space', 'verify']
        assert not (update/'Penkra.app').exists()
    print('database preflight relaunch result check passed')


if __name__ == '__main__':
    check()
