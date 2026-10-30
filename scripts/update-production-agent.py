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
    codex = os.environ.get("PENKRA_UPDATE_CODEX_BIN")
    if not codex:
        versions = Path.home() / "Penkra/.penkra/userdata/provider-runtimes/codex/versions"
        candidates = [(tuple(int(part) for part in item.name.split(".")), item / "bin/codex") for item in versions.iterdir() if item.is_dir() and all(part.isdigit() for part in item.name.split(".")) and (item / "bin/codex").is_file()] if versions.is_dir() else []
        codex = str(max(candidates, key=lambda item: item[0])[1]) if candidates else shutil.which("codex")
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
The app owns backup and migration. Never delete or edit a database or backup. The only authorized database operation is failure recovery described in step 6: move the closed failed database and sidecars into failed-db/, copy the exact app-created pre-migration snapshot recorded for this launch into place, and perform a read-only integrity check. Never alter or delete any file in userdata/state.sqlite.backups or any .corrupt file; reading and copying the exact verified rollback snapshot is authorized.
Do not read secrets. Do not use launchctl submit, retry loops, polling intervals, sleeps, or guessed deadlines.
Use /usr/bin/shasum -a 256 for archive hashes; do not use hashlib.file_digest (unavailable in system Python 3.9). When enumerating app processes, request pid and comm, not full command arguments; argument enumeration can block on an unrelated process. Exercise every helper's hashing and watcher APIs before asking Production to quit.
Launch both candidate and rollback apps with subprocess.Popen(..., start_new_session=True), with stdout/stderr directed to a retained file, never a helper-owned pipe. The app must survive the helper and command-execution session exiting; a successful readiness response before helper exit is not sufficient. Verify exact app/backend PIDs and readiness again after that launch helper exits, before reporting success. Maintain process-exit observation during startup; detaching the process session does not waive any failure gate.
Append each step, command, result, timestamp and failure to update.log in the update directory.
Write report.md beginning UPDATE OK or ROLLED BACK, or PREFLIGHT FAILED if nothing changed.

1. Verify codesign --verify --deep --strict and that codesign --display --verbose=4 shows Developer ID Application. For this local non-quarantined build, record spctl --assess informationally, not as a gate. Never remove quarantine or relax system Gatekeeper settings. On codesign failure, do not quit or change Production.
2. Record installed version and sizes using Info.plist/stat only; record candidate Contents/Resources/app.asar SHA256; record the current end of both log files so old success entries cannot pass this update.
3. Ask Penkra to quit with osascript. Register exit watchers for its process ids before asking it to quit; wait for process exit (macOS kqueue NOTE_EXIT or caffeinate -w PID, not sleeps). Confirm every owner exited and lsof shows no owner of state.sqlite or its WAL/SHM. BEFORE moving either app, run the candidate's packaged penkra-database verify command against Production: ELECTRON_RUN_AS_NODE=1 <candidate>/Contents/MacOS/Penkra <candidate>/Contents/Resources/app.asar/apps/server/dist/databaseMaintenance.mjs verify <absolute-Production-state.sqlite>. It acquires the canonical lifecycle lock, checks the SQLite safety version and verifies integrity. Use this supported command, not a system sqlite3 or ad-hoc database script. On failure SWAP NOTHING, relaunch the recorded old version, verify its readiness, write PREFLIGHT FAILED, and stop. Never edit or delete any database, sidecar or historical backup.
4. Move /Applications/Penkra.app to the update directory as Penkra.app; use ditto to copy the candidate to /Applications/Penkra.app. Verify the installed Developer ID signature and version and require its Contents/Resources/app.asar SHA256 to match the candidate exactly (required even for a same-version swap); record spctl informationally. Keep the old bundle until the operator chooses to delete it. This operator-approved fixed-shortcut update also removes ~/Penkra/.penkra/userdata/keybindings.json from active userdata: if present, move that exact non-database file into this update directory as retired-keybindings.json, recording the move. It contains only Penkra-written defaults. Do not touch any other preferences. If rolling back the app in step 6, move this saved file back to its original location before launching the old app.
5. Before launching, register native filesystem watches on userdata and logs. Launch /Applications/Penkra.app/Contents/MacOS/Penkra as an owned subprocess. Observe its exit and the exact backend PID from fresh desktop.log. The server no longer emits Listening on http. Instead wait for the app-owned userdata/server-runtime.json, written atomically only after HTTP binds. Its version=1, pid, port, origin and startedAt must identify this newly launched backend; reject stale files. Watch the parent directory so atomic rename cannot lose the event; check once immediately after registering/launching, then react to events, not a polling loop. Request that origin/status; it waits for readiness. Success requires JSON reporting the expected app version and migration.status='ok'. Failure is JSON migration.status='failed' or app/backend process exit. Capture any fresh database.migration.backup_ready event from server.log, including the exact Production databasePath, backupPath, sourceVersion and targetVersion. Record and integrity-verify that app-created snapshot as this launch's rollback source whenever migrations ran. A no-migrations startup needs no database rollback. Never reuse an older snapshot. Race status with exact process exits; no readiness deadline, sleeps or retry loops. Progress logging must never trigger failure or cancellation.
Readiness-monitor requirements: startup rotates logs. Watch their parent directories, tolerate missing files during rotation, and reopen current paths on directory events. Track file identity and reset offsets after replacement or truncation; a missing/rotated log is progress only, never an update failure. Do not assume a backend/server word precedes the PID: the actual desktop spawn line is '[desktop run=<id>] pid=<pid> port=<port> cwd=<path>'. Match this launch's spawn record, verify server-runtime.json agrees with that exact PID/port and its fresh start time, and register exact process-exit watches. Preserve the recorded pre-launch log boundary when the file has not changed identity. These rules apply equally to the candidate and rollback readiness checks. Before quitting Production, exercise the actual monitor's directory-watch and child-process-exit setup with the exact interpreter it will use. For Python kqueue directory watches, use os.O_RDONLY; the system Python does not expose os.O_EVTONLY. Do not begin a swap until watcher preflight passes.
Migration event wire format: server.log is logfmt, not a raw JSON document. A backup_ready line has message=database.migration.backup_ready followed by another message field containing a JSON-quoted JSON object. Parse the logfmt fields preserving repeated keys, decode the quoted message value, then JSON-decode that object's text. The object's keys are databasePath, backupPath, sourceVersion and targetVersion. Never extract the substring beginning at the first brace: its quotes are escaped by the outer logfmt value. Before quitting Production, test your parser against an actual existing backup_ready log line and verify those four fields. Save the exact validated event before performing snapshot verification so a later observer failure cannot lose the rollback identity. An observer/parser failure is not evidence the application or migration failed; establish the actual process and readiness state before selecting recovery. Never launch an old build against a successfully upgraded database without restoring the exact validated snapshot first.
The system Python does not expose KQ_FILTER_USER or KQ_NOTE_TRIGGER. Use a socketpair registered with KQ_FILTER_READ to wake the monitor when an HTTP worker completes. BEFORE shutdown, instantiate the actual launch monitor, complete one HTTP-worker wake through that socketpair, and exercise its process-exit and directory watches. Testing a different minimal watcher is insufficient. Reuse those exact tested monitor paths for candidate and rollback; do not add an untested wake primitive after preflight.
6. On failure after the old bundle moved, quit the candidate and wait for every database owner to exit. If migrations committed, use ONLY the exact verified backupPath captured from this launch's database.migration.backup_ready event (not state.pre-0.14.4.sqlite). First validate that source with the packaged lifecycle-aware penkra-database verify command. Move current state.sqlite and any WAL/SHM into this update directory's failed-db/, then copy that exact snapshot to the original database path and verify it before relaunch. Preserve the source snapshot and failed DB; never edit or delete either. If no migration ran, or the migration transaction rolled back leaving the database unchanged, do not restore a database. If the exact required snapshot is unavailable, preserve all files and report that limitation; never guess or substitute an older backup. Move the failed candidate to failed-Penkra.app, restore the saved old app to /Applications/Penkra.app and launch it. Verify the recorded old version's readiness: 0.14.4 uses /status JSON migration.status='ok'; 0.14.3 uses /health JSON startupReady=true (its /status is HTML). Record the exact rollback result. Never alter/delete userdata backups or .corrupt files; only read/copy the exact rollback snapshot.
7. Record the final installed version, PID, /status and migration outcome or exact rollback limitation in update.log and report.md. Show a macOS notification summarizing the report. Exit after this one attempt. Do not re-run yourself.
"""
    previous_updates = sorted((path for path in folder.parent.iterdir() if path.is_dir() and path != folder), key=lambda path: path.name, reverse=True)
    prior_helper = next((path / "updater.py" for path in previous_updates if (path / "updater.py").is_file() and (path / "report.md").is_file() and (path / "report.md").read_text().startswith("UPDATE OK") and (path / "prompt.md").is_file() and "For this recovery only" not in (path / "prompt.md").read_text()), None)
    if prior_helper:
        prompt += f"\nA helper from the last successful update is at {prior_helper} (and finalize.py if present). Copy it into this folder as the starting point, adapt only the candidate path, app paths and this run's recovery instructions, then run the required preflight (HTTP-worker wake, directory-event exercise, rotation handling, post-helper exit check) against the copy. Don't write a new monitor unless the copied one fails preflight; then report why.\n"
    if os.environ.get("PENKRA_UPDATE_NO_ROLLBACK") == "1":
        prompt += "\nFor this recovery only: the old public app cannot open the current database. If the candidate fails, stop and report the outcome; do not restore a backup or relaunch the old app. No migration is expected. This overrides step 6 above.\n"
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
            version = subprocess.run([codex, "--version"], capture_output=True, text=True)
            log.write(("Updater Codex: " + str(codex) + "\nVersion: " + (version.stdout or version.stderr).strip() + "\n").encode())
            log.write(("Selected prior helper: " + (str(prior_helper.parent) if prior_helper else "none") + " (newest successful normal-update run; recovery-only runs excluded)\n").encode())
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
