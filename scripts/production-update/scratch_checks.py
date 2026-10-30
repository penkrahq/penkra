#!/usr/bin/env python3
"""Check scratch path isolation and separate-worker result handling."""
import json
import pathlib
import tempfile

import helper


def check():
    with tempfile.TemporaryDirectory(prefix='penkra-scratch-worker-') as directory:
        root = pathlib.Path(directory).resolve()
        home = root / 'home'
        penkra_root = home / 'Penkra'
        pointer = home / 'Library/Application Support/Penkra/root.json'
        pointer.parent.mkdir(parents=True)
        pointer.write_text(json.dumps({'root': str(penkra_root)}))
        candidate = root / 'candidate.app'
        candidate.mkdir()
        userdata = penkra_root / '.penkra/userdata'
        userdata.mkdir(parents=True)
        update = root / 'update'
        update.mkdir()
        config = {'root': str(root), 'candidate': str(candidate),
                  'installed': str(root / 'Applications/Penkra.app'),
                  'userdata': str(userdata), 'update': str(update)}
        helper.configure_scratch(config)
        assert helper.LAUNCH_ENV['HOME'] == str(home)
        try:
            helper.configure_scratch({**config, 'installed': '/Applications/Penkra.app'})
        except RuntimeError as error:
            assert 'inside the rehearsal root' in str(error)
        else:
            raise AssertionError('Production install path was accepted')
        pointer.write_text(json.dumps({'root': str(pathlib.Path.home() / 'Penkra')}))
        try:
            helper.configure_scratch(config)
        except RuntimeError as error:
            assert 'root pointer' in str(error)
        else:
            raise AssertionError('Production data pointer was accepted')
        pointer.write_text(json.dumps({'root': str(penkra_root)}))
        try:
            helper.run_scratch_worker(config, 'invalid')
        except RuntimeError as error:
            assert 'without a result' in str(error)
            assert 'unknown scratch worker action' in (root / 'workers.log').read_text()
        else:
            raise AssertionError('failed worker was accepted')
    print('scratch isolation and separate-worker failure checks passed')


if __name__ == '__main__':
    check()
