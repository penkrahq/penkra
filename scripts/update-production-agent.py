#!/usr/bin/env python3
"""Preflight a candidate and launch exactly one detached Codex outside Penkra."""
import datetime
import json
import os
from pathlib import Path
import plistlib
import resource
import shutil
import subprocess
import sys


def main():
    if sys.platform != "darwin" or len(sys.argv) != 2:
        raise SystemExit("usage (macOS): update-production-agent.py <new-Penkra.app>")
    candidate = Path(sys.argv[1]).expanduser().resolve(strict=True)
    if candidate.name != "Penkra.app" or candidate == Path("/Applications/Penkra.app"):
        raise SystemExit("Provide a separately built Penkra.app; Production is not a candidate.")
    # Preflight precedes any filesystem mutation or detached agent launch.
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(candidate)], check=True)
    signature = subprocess.run(["/usr/bin/codesign", "--display", "--verbose=4", str(candidate)], capture_output=True, text=True, check=True)
    if "Authority=Developer ID Application:" not in signature.stderr:
        raise SystemExit("Candidate is not Developer ID signed.")
    quarantine = subprocess.run(["/usr/bin/xattr", "-p", "com.apple.quarantine", str(candidate)], capture_output=True)
    if quarantine.returncode == 0:
        raise SystemExit("Local 5A requires a locally built, non-quarantined app; do not remove quarantine here.")
    assessment = subprocess.run(["/usr/sbin/spctl", "--assess", "--type", "execute", str(candidate)], capture_output=True, text=True)
    print("Informational spctl assessment: " + str(assessment.returncode), flush=True)
    with (candidate / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    if info.get("CFBundleIdentifier") != "com.penkra.app":
        raise SystemExit("Candidate has the wrong Production bundle identity.")
    version = info["CFBundleShortVersionString"]
    codex = os.environ.get("PENKRA_UPDATE_CODEX_BIN") or shutil.which("codex")
    if not codex or not Path(codex).is_file():
        raise SystemExit("Set PENKRA_UPDATE_CODEX_BIN to an installed standalone Codex executable.")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    folder = Path.home() / "Penkra/.penkra/updates" / stamp
    folder.mkdir(parents=True, mode=0o700)
    prompt = f"""You are the approved one-shot Production updater, detached outside Penkra.
Candidate: {json.dumps(str(candidate))}
Expected version: {json.dumps(version)}
Update directory: {json.dumps(str(folder))}
Production app: /Applications/Penkra.app
Production logs: ~/Penkra/.penkra/userdata/logs/desktop.log and server.log

Execute this transaction now, reason about failures, and always leave a working old or new Penkra in /Applications.
Do not publish, push, tag, bump versions, edit source, or install anything else.
The app owns backup and migration. Never delete or edit a database or backup. The only authorized database operation is failure recovery described in step 6: move the closed failed database and sidecars into failed-db/, copy the preserved pre-0.14.4 snapshot into place, and perform a read-only integrity check. Never touch userdata/state.sqlite.backups or any .corrupt file.
Do not read secrets. Do not use launchctl submit, retry loops, polling intervals, sleeps, or guessed deadlines.
Append each step, command, result, timestamp and failure to update.log in the update directory.
Write report.md beginning UPDATE OK or ROLLED BACK, or PREFLIGHT FAILED if nothing changed.

1. Verify codesign --verify --deep --strict and that codesign --display --verbose=4 shows Developer ID Application. For this local non-quarantined build, record spctl --assess informationally, not as a gate. Never remove quarantine or relax system Gatekeeper settings. On codesign failure, do not quit or change Production.
2. Record installed version and sizes using Info.plist/stat only; record the current end of both log files so old success entries cannot pass this update.
3. Ask Penkra to quit with osascript. Register exit watchers for its process ids before asking it to quit; wait for process exit (macOS kqueue NOTE_EXIT or caffeinate -w PID, not sleeps). Confirm the processes are gone.
4. Move /Applications/Penkra.app to the update directory as Penkra.app; use ditto to copy the candidate to /Applications/Penkra.app. Verify the installed Developer ID signature and version; record spctl informationally. Keep the old bundle until the operator chooses to delete it.
5. Launch /Applications/Penkra.app/Contents/MacOS/Penkra as a subprocess so you own its exact PID. Observe native process exit and new log writes. The new server.log's 'Listening on http://' gives its local port; wait on filesystem events, not a poll. Request http://127.0.0.1:<port>/status: the response waits for readiness. It must report the expected version and migration.status='ok'. Check new server.log contains 'Migration startup result' with status ok. Race status with app/backend exit; an exit or a recorded failed migration is a failure, never a success. Observe the backend PID from new desktop.log and register its exit as well. Do not accept an old status endpoint or old log entries.
6. On any failure after the old bundle moved: quit the new app and wait for every app/backend database owner to exit. If migration committed, create failed-db/ under this update directory and MOVE the current state.sqlite and any -wal/-shm sidecars into it (never delete them). COPY ~/Penkra/.penkra/userdata/state.pre-0.14.4.sqlite into the original state.sqlite path, and require a read-only immutable PRAGMA integrity_check to return ok before relaunch. Preserve the backup itself and the failed DB. If migration did not commit and the database is unchanged, no database restore is needed. Never guess which snapshot is safe: use only that integrity-checked fixed pre-0.14.4 snapshot. Move the installed failed candidate into the update directory as failed-Penkra.app, restore the saved old bundle to /Applications/Penkra.app and launch it; verify it responds. Reason about permissions or launch failures until a working old or new app is installed. Record the exact restore and rollback result. No editing database contents, no deletion of databases/backups, no touching state.sqlite.backups or .corrupt files.
7. Record the final installed version, PID, /status and migration outcome or exact rollback limitation in update.log and report.md. Show a macOS notification summarizing the report. Exit after this one attempt. Do not re-run yourself.
"""
    (folder / "prompt.md").write_text(prompt)
    command = [codex, "-a", "never", "exec", "--skip-git-repo-check", "-C", str(folder),
               "-s", "danger-full-access", "-c", 'mcp_servers.penkra={url="http://127.0.0.1/unused",enabled=false}',
               "-o", str(folder / "codex-last-message.md"), "-"]
    pid = os.fork()
    if pid:
        os.waitpid(pid, 0)
        print("Updater started; Penkra will quit and relaunch.", flush=True)
        print("Report: " + str(folder / "report.md"), flush=True)
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    os.chdir(folder)
    os.umask(0o077)
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    maximum = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    os.closerange(3, 65536 if maximum == resource.RLIM_INFINITY else int(maximum))
    env = {key: value for key, value in os.environ.items() if not key.startswith("PENKRA_")}
    try:
        with (folder / "prompt.md").open("rb") as source, (folder / "run.log").open("ab", buffering=0) as log:
            child = subprocess.Popen(command, stdin=source, stdout=log, stderr=log, env=env)
            status = child.wait()
        (folder / "agent-exit.json").write_text(json.dumps({"exitCode": status}))
        if not (folder / "report.md").exists():
            (folder / "report.md").write_text("UPDATER AGENT FAILED: no report was written; inspect run.log before any retry.\n")
        summary = (folder / "report.md").read_text().splitlines()[0]
        subprocess.run(["/usr/bin/osascript", "-e", "display notification " + json.dumps(summary) + ' with title "Penkra update"'], check=False)
    except Exception as cause:
        (folder / "report.md").write_text("UPDATER AGENT FAILED: " + str(cause) + "\nInspect installed state before retrying.\n")
    os._exit(0)


if __name__ == "__main__":
    main()
