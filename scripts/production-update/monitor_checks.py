#!/usr/bin/env python3
"""Scratch-only checks of the P44 monitor; never opens Production files."""
import datetime
import http.server
import json
import os
import shutil
import signal
import sys
import subprocess
import threading
import pathlib
import tempfile
import time

import helper


def check():
    with tempfile.TemporaryDirectory(prefix="penkra-update-monitor-") as directory:
        root = pathlib.Path(directory)
        updates = root / "updates"
        userdata = root / "userdata"
        logs = userdata / "logs"
        backups = userdata / "state.sqlite.backups"
        updates.mkdir()
        logs.mkdir(parents=True)
        backups.mkdir()
        desktop = logs / "desktop.log"
        server = logs / "server.log"
        desktop.write_bytes(b"before\n")
        server.write_bytes(b"")
        old = backups / "old.sqlite"
        old.write_bytes(b"old")
        helper.configure(updates, root / "candidate.app", root / "installed.app", userdata)
        monitor = helper.Monitor(helper.boundaries())
        monitor.launch_time = time.time() - 1
        try:
            with desktop.open("ab") as stream:
                stream.write(b"part")
            assert monitor.lines("desktop.log") == []
            with desktop.open("ab") as stream:
                stream.write(b"ial\n")
            assert monitor.lines("desktop.log") == ["partial"]
            desktop.rename(logs / "desktop.log.1")
            desktop.write_bytes(b"replacement\n")
            assert monitor.lines("desktop.log") == ["replacement"]
            desktop.write_bytes(b"x")
            try:
                monitor.lines("desktop.log")
            except RuntimeError as error:
                assert "shrank" in str(error)
            else:
                raise AssertionError("same-inode shrink was accepted")

            desktop.rename(logs / "desktop.log.shrunk")
            desktop.write_bytes(b"reset\n")

            fresh = backups / "new.sqlite"
            fresh.write_bytes(b"fixture")
            event = {"databasePath": str(userdata / "state.sqlite"), "backupPath": str(fresh),
                     "sourceVersion": "v214", "targetVersion": 215}
            timestamp = helper.datetime.datetime.now(helper.datetime.timezone.utc).isoformat()
            server.write_text("timestamp=" + timestamp + " message=database.migration.backup_ready message=" +
                              json.dumps(json.dumps(event)) + "\n")
            monitor.scan()
            assert monitor.backup == event
            assert json.loads((updates / "launch-backup-event.json").read_text()) == event
            event["backupPath"] = str(old)
            with server.open("a") as stream:
                stream.write("timestamp=" + timestamp + " message=database.migration.backup_ready message=" +
                             json.dumps(json.dumps(event)) + "\n")
            try:
                monitor.scan()
            except RuntimeError as error:
                assert "new backup directory entry" in str(error)
            else:
                raise AssertionError("pre-existing backup was accepted")
            # Exercise readiness against real disposable processes and a loopback server.
            executable = root / "installed.app" / "Contents" / "MacOS" / "Penkra"
            executable.parent.mkdir(parents=True)
            shutil.copyfile("/bin/cat", executable)
            executable.chmod(0o755)
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(executable)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            class Handler(http.server.BaseHTTPRequestHandler):
                status = "ok"
                def do_GET(self):
                    body = json.dumps({"version": "0.14.6", "migration": {"status": self.status}}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                def log_message(self, *args):
                    pass
            server_http = http.server.HTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=server_http.serve_forever, daemon=True)
            worker.start()
            children = []
            try:
                children = [subprocess.Popen([str(executable)], stdin=subprocess.PIPE,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                            for _ in range(2)]
                port = server_http.server_port
                launch_time = time.time() - 1
                (userdata / "server-runtime.json").write_text(json.dumps({
                    "version": 1, "pid": children[1].pid, "port": port,
                    "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "origin": f"http://127.0.0.1:{port}"}))
                result = helper.verify_after_launch_helper_exit(children[0].pid, children[1].pid, "0.14.6", launch_time)
                assert result["migration"]["status"] == "ok"
                try:
                    helper.verify_after_launch_helper_exit(children[0].pid, children[1].pid, "0.14.6", time.time() + 60)
                except RuntimeError as error:
                    assert "predates" in str(error)
                else:
                    raise AssertionError("stale runtime was accepted")
                Handler.status = "failed"
                try:
                    helper.verify_after_launch_helper_exit(children[0].pid, children[1].pid, "0.14.6", launch_time)
                except RuntimeError as error:
                    if "not ready" not in str(error):
                        print("child status at failure:", [(c.pid, c.poll()) for c in children])
                    assert "not ready" in str(error)
                else:
                    raise AssertionError("failed migration readiness was accepted")
                children[1].stdin.close()
                children[1].wait()
                try:
                    helper.verify_after_launch_helper_exit(children[0].pid, children[1].pid, "0.14.6", launch_time)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("exited backend accepted")
            finally:
                for child in children:
                    if child.poll() is None:
                        child.stdin.close()
                        child.wait()
                server_http.shutdown()
                server_http.server_close()
                worker.join()
            # A separate launch helper exits before the monitored processes are checked.
            detached_app = root / "detached.app"
            detached_executable = detached_app / "Contents" / "MacOS" / "Penkra"
            detached_executable.parent.mkdir(parents=True)
            shutil.copyfile("/bin/sleep", detached_executable)
            detached_executable.chmod(0o755)
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(detached_executable)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            helper.configure(updates, root / "candidate.app", detached_app, userdata)
            server_http = http.server.HTTPServer(("127.0.0.1", 0), Handler)
            Handler.status = "ok"
            worker = threading.Thread(target=server_http.serve_forever, daemon=True)
            worker.start()
            detached_pids = []
            try:
                launch_time = time.time() - 1
                script = ("import json,subprocess,sys; "
                          "p=[subprocess.Popen([sys.argv[1], '60'], start_new_session=True, "
                          "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).pid "
                          "for _ in range(2)]; print(json.dumps(p))")
                detached_pids = json.loads(subprocess.check_output(
                    [sys.executable, "-c", script, str(detached_executable)], text=True))
                port = server_http.server_port
                (userdata / "server-runtime.json").write_text(json.dumps({
                    "version": 1, "pid": detached_pids[1], "port": port,
                    "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "origin": f"http://127.0.0.1:{port}"}))
                result = helper.verify_after_launch_helper_exit(detached_pids[0], detached_pids[1],
                                                                "0.14.6", launch_time)
                assert result["migration"]["status"] == "ok"
            finally:
                for pid in detached_pids:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                server_http.shutdown()
                server_http.server_close()
                worker.join()
            print("monitor and post-launch scratch checks passed")
        finally:
            monitor.close()


if __name__ == "__main__":
    check()
