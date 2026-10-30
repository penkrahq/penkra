#!/usr/bin/env python3
"""Check post-worker failure routing without changing installed applications."""
import helper
import pathlib
import tempfile


def check():
    original_version, original_verify = helper.version, helper.verify_after_launch_helper_exit
    original_note = helper.note
    helper.C, helper.P = object(), object()
    installed = ['new']
    helper.version = lambda app: 'new' if app is helper.C else installed[0]
    helper.note = lambda message: None
    calls = []
    def verify(app, backend, expected, launched):
        calls.append((app, backend, expected, launched))
        if app == 10:
            raise RuntimeError('candidate exited after launch worker')
        return {'migration': {'status': 'ok'}}
    helper.verify_after_launch_helper_exit = verify
    def launch_rollback(oldversion, backup, reason):
        assert oldversion == 'old' and backup == {'backupPath': 'snapshot'}
        assert 'candidate exited' in reason
        installed[0] = 'old'
        return ('rollback', 20, 21, {}, backup,
                {'oldversion': oldversion, 'reason': reason}, 200)
    try:
        result = helper.supervise_result(
            ('success', 10, 11, {}, {'backupPath': 'snapshot'}, 'old', 100),
            launch_rollback,
        )
        assert result[0] == 'rollback'
        assert calls == [(10, 11, 'new', 100), (20, 21, 'old', 200)]
        helper.verify_after_launch_helper_exit = lambda *args: (_ for _ in ()).throw(RuntimeError('old exited'))
        try:
            helper.supervise_result(result, launch_rollback)
        except RuntimeError as error:
            assert 'restored app failed' in str(error)
        else:
            raise AssertionError('failed rollback verification was accepted')
    finally:
        helper.version, helper.verify_after_launch_helper_exit = original_version, original_verify
        helper.note = original_note
    with tempfile.TemporaryDirectory(prefix='penkra-supervisor-report-') as directory:
        root = pathlib.Path(directory)
        saved = (helper.configure_production, helper.supervise_transaction,
                 helper.report, helper.version, helper.U, helper.P, helper.OLD)
        reports = []
        helper.U, helper.P, helper.OLD = root, root/'installed.app', root/'old.app'
        helper.configure_production = lambda config: None
        helper.supervise_transaction = lambda config, worker: ('rollback', 20, 21,
            {'migration': {'status': 'ok'}}, None, {'reason': 'test failure'}, 200)
        helper.report = lambda title, detail: reports.append((title, detail))
        helper.version = lambda app: '0.14.6'
        try:
            helper.supervise_production({})
            assert reports[0][0] == 'ROLLED BACK' and 'test failure' in reports[0][1]
            (root/'transaction-state.json').write_text('{}')
            helper.supervise_transaction = lambda config, worker: (_ for _ in ()).throw(RuntimeError('failed'))
            try: helper.supervise_production({})
            except RuntimeError: pass
            else: raise AssertionError('failed supervisor was accepted')
            assert reports[-1][0] == 'ROLLBACK INCOMPLETE'
        finally:
            (helper.configure_production, helper.supervise_transaction,
             helper.report, helper.version, helper.U, helper.P, helper.OLD) = saved
    with tempfile.TemporaryDirectory(prefix='penkra-worker-exit-') as directory:
        root = pathlib.Path(directory)
        saved = (helper.U, helper.OLD, helper.quit_all, helper.supervise_result, helper.note)
        helper.U, helper.OLD = root, root/'old.app'
        helper.OLD.mkdir()
        (root/'transaction-state.json').write_text('{"oldversion":"0.14.6"}')
        helper.quit_all = lambda: None
        helper.note = lambda message: None
        helper.supervise_result = lambda result, callback: result
        calls = []
        def worker(config, action, **extra):
            calls.append((action, extra))
            if action == 'transaction': raise RuntimeError('worker died')
            assert extra['oldversion'] == '0.14.6' and extra['backup'] is None
            return ('rollback', 20, 21, {}, None, {'oldversion': '0.14.6'}, 200)
        try:
            assert helper.supervise_transaction({}, worker)[0] == 'rollback'
            assert [call[0] for call in calls] == ['transaction', 'rollback']
            helper.OLD.rmdir()
            (root/'preflight-state.json').write_text('{"oldversion":"0.14.6"}')
            calls.clear()
            def preflight_worker(config, action, **extra):
                calls.append(action)
                if action == 'transaction': raise RuntimeError('worker died before swap')
                assert action == 'relaunch-existing' and extra['oldversion'] == '0.14.6'
                return ('preflight', 20, 21, {}, None, {'oldversion': '0.14.6'}, 200)
            assert helper.supervise_transaction({}, preflight_worker)[0] == 'preflight'
            assert calls == ['transaction', 'relaunch-existing']
        finally:
            helper.U, helper.OLD, helper.quit_all, helper.supervise_result, helper.note = saved
    print('post-helper verification and rollback supervision checks passed')


if __name__ == '__main__':
    check()
