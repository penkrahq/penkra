#!/usr/bin/python3
import socket, threading, tempfile, datetime, hashlib, json, os, pathlib, plistlib, re, select, shutil, signal, sqlite3, stat, subprocess, sys, time, urllib.request

# No production paths are bound until an explicit transaction configuration exists.
U = C = P = D = DB = LOGS = LOG = OUT = OLD = FAILED = KEY = SAVED = None
LAUNCH_ENV = None
IS_SCRATCH = False
SCRATCH_FAULT = None
SCRATCH_PROOF = False

def configure(update_dir, candidate, installed_app, userdata, launch_env=None, scratch=False):
    global U, C, P, D, DB, LOGS, LOG, OUT, OLD, FAILED, KEY, SAVED
    global LAUNCH_ENV, IS_SCRATCH
    U, C, P, D = map(pathlib.Path, (update_dir, candidate, installed_app, userdata))
    DB = D / "state.sqlite"
    LOGS = D / "logs"
    LOG = U / "update.log"
    OUT = U / "launch-output.log"
    OLD = U / "Penkra.app"
    FAILED = U / "failed-Penkra.app"
    KEY = D / "keybindings.json"
    SAVED = U / "retired-keybindings.json"
    LAUNCH_ENV = launch_env
    IS_SCRATCH = scratch

EV_ADD=select.KQ_EV_ADD|select.KQ_EV_ENABLE|select.KQ_EV_CLEAR
VNODE=select.KQ_NOTE_WRITE|select.KQ_NOTE_RENAME|select.KQ_NOTE_DELETE|select.KQ_NOTE_EXTEND

def note(msg):
    s=datetime.datetime.now(datetime.timezone.utc).isoformat()+' '+str(msg)
    with LOG.open('a') as f: f.write(s+'\n'); f.flush(); os.fsync(f.fileno())
    print(s,flush=True)

def save_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(str(temporary), str(path))
    fd = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def cmd(args,env=None,gate=True):
    note('COMMAND '+repr(args))
    r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=env)
    note('RESULT exit='+str(r.returncode)+' output='+r.stdout[-4000:])
    if gate and r.returncode: raise RuntimeError('command failed: '+repr(args)+' exit='+str(r.returncode))
    return r

def version(app):
    with (app/'Contents/Info.plist').open('rb') as f: return plistlib.load(f)['CFBundleShortVersionString']
def sha(path): return cmd(['/usr/bin/shasum','-a','256',str(path)]).stdout.split()[0]
def size(path): return path.stat().st_size
def verify_db(path,app=None):
    app = C if app is None else app
    exe=app/'Contents/MacOS/Penkra'; script=app/'Contents/Resources/app.asar/apps/server/dist/databaseMaintenance.mjs'
    env=os.environ.copy(); env['ELECTRON_RUN_AS_NODE']='1'
    return cmd([str(exe),str(script),'verify',str(path)],env=env)

def space_preflight():
    """Check a conservative filesystem-only bound while Production is running."""
    total = DB.stat().st_size
    for suffix in ('-wal', '-shm'):
        try: total += pathlib.Path(str(DB) + suffix).stat().st_size
        except FileNotFoundError: pass
    required = 4 * total
    filesystem = os.statvfs(D)
    available = filesystem.f_bavail * filesystem.f_frsize
    note('space preflight required='+str(required)+' available='+str(available))
    if available < required:
        gib = (required + 1024**3 - 1) // 1024**3
        raise RuntimeError('not enough free disk space (need '+str(gib)+' GB); required '+str(required)+' bytes, available '+str(available))

def migration_preflight():
    """Verify the stopped database under its lifecycle lock and compare migration IDs."""
    result = verify_db(DB)
    try: current = json.loads(result.stdout)['latestMigrationId']
    except (ValueError, KeyError, TypeError) as error:
        raise RuntimeError('database migration ID is unavailable from penkra-database verify') from error
    if not isinstance(current, int) or isinstance(current, bool):
        raise RuntimeError('database migration ID is unavailable from penkra-database verify')
    script = r'''const fs=require('fs'),path=require('path');
const dir=path.join(process.argv[1],'Contents/Resources/app.asar/apps/server/dist');
const found=[]; for(const f of fs.readdirSync(dir).filter(x=>/^MigrationBackup.*\.mjs$/.test(x))) {
 const s=fs.readFileSync(path.join(dir,f),'utf8');
 const m=s.match(/\bmigrationEntries\s*=\s*\[([\s\S]*?)\]\s*;/);
 if(!m) continue; const ids=[...m[1].matchAll(/\[\s*(\d+)\s*,/g)].map(x=>Number(x[1]));
 if(ids.length) found.push(Math.max(...ids)); }
if(found.length!==1) throw Error('candidate migration list not uniquely identifiable');
console.log(found[0]);'''
    env=os.environ.copy(); env['ELECTRON_RUN_AS_NODE']='1'
    result=cmd([str(C/'Contents/MacOS/Penkra'),'-e',script,str(C)],env=env)
    try: candidate=int(result.stdout.strip())
    except ValueError: raise RuntimeError('candidate migration ID is unreadable')
    if candidate < current: raise RuntimeError('candidate migration ID is older than database')
    note('migration preflight database='+str(current)+' candidate='+str(candidate))

def proc_table():
    r=cmd(['/bin/ps','-axo','pid=,comm='])
    ans={}
    for line in r.stdout.splitlines():
        m=re.match(r'\s*(\d+)\s+(.*)',line)
        if m: ans[int(m[1])]=m[2]
    return ans
def owners():
    return {p:c for p,c in proc_table().items() if c.startswith(str(P)+'/Contents/')}
def lsof_db():
    result=[]
    for path in (DB,pathlib.Path(str(DB)+'-wal'),pathlib.Path(str(DB)+'-shm')):
        if path.exists():
            r=cmd(['/usr/sbin/lsof','-Fpc','--',str(path)],gate=False)
            if r.returncode==0 and r.stdout.strip(): result.append((str(path),r.stdout))
    return result
def kevent_proc(pid): return select.kevent(pid,filter=select.KQ_FILTER_PROC,flags=EV_ADD,fflags=select.KQ_NOTE_EXIT)
def kevent_dir(fd): return select.kevent(fd,filter=select.KQ_FILTER_VNODE,flags=EV_ADD,fflags=VNODE)
def parse_backup(line):
    fields=[]
    for m in re.finditer(r'(\w+)=(' + r'"(?:\\.|[^"\\])*"|[^\s]+' + r')',line):
        v=m[2]
        fields.append((m[1],json.loads(v) if v.startswith('"') else v))
    messages=[v for k,v in fields if k=='message']
    if not any('database.migration.backup_ready' in v for v in messages): return None
    for v in messages:
        try: obj=json.loads(v)
        except (ValueError,TypeError): continue
        if isinstance(obj,dict) and all(k in obj for k in ('databasePath','backupPath','sourceVersion','targetVersion')):
            if obj['databasePath']!=str(DB): raise RuntimeError('backup database path mismatch')
            return obj
    raise RuntimeError('backup_ready event missing required object')

def watcher_preflight():
    note('PREFLIGHT actual Monitor '+sys.executable)
    lines=(LOGS/'server.log').read_text(errors='replace').splitlines()
    event=next(parse_backup(x) for x in reversed(lines) if 'database.migration.backup_ready' in x)
    note('parser exercised four required fields '+repr(event))
    mon=Monitor(boundaries())
    child=subprocess.Popen(['/bin/cat'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        mon.watch_process(child.pid)
        mon.worker(lambda: {'preflight':True})
        while mon.http_result is None: mon.events()
        mon.events(False)
        if mon.http_result!=('ok',{'preflight':True}): raise RuntimeError('HTTP worker wake failed')
        probe=U/'watch-probe'
        # Exercise the actual registered userdata parent directory without touching preferences.
        probe=D/('.penkra-updater-watch-'+str(os.getpid()))
        probe.touch()
        while not any(e.filter==select.KQ_FILTER_VNODE and e.ident==mon.fds[0] for e in mon.events()): pass
        probe.unlink()
        child.stdin.close()
        while child.pid not in mon.exited: mon.events()
        child.wait()
        note('actual monitor directory, process exit, socketpair HTTP wake passed')
    finally: mon.close()

def boundaries():
    ans={}
    for name in ('desktop.log','server.log'):
        p=LOGS/name
        try:
            st=p.stat(); ans[name]=[st.st_dev,st.st_ino,st.st_size]
        except FileNotFoundError: ans[name]=None
    note('log boundaries '+repr(ans)); return ans

class Monitor:
    def __init__(self,bounds):
        self.k=select.kqueue(); self.fds=[]; self.pos={n:list(v) if v else None for n,v in bounds.items()}
        self.pending={n:b'' for n in bounds}; self.exited=set(); self.watched=set()
        self.backup_dir = D / "state.sqlite.backups"
        self.initial_backups = {entry.name for entry in self.backup_dir.iterdir()}
        for path in (D,LOGS,self.backup_dir):
            fd=os.open(path,os.O_RDONLY); self.fds.append(fd); self.k.control([kevent_dir(fd)],0,0)
        self.rx,self.tx=socket.socketpair()
        self.k.control([select.kevent(self.rx.fileno(),filter=select.KQ_FILTER_READ,flags=EV_ADD)],0,0)
        self.observer_errors=[]; self.http_result=None; self.pid=None; self.port=None; self.run=None; self.backup=None; self.unsafe_no_backup=False
    def close(self):
        self.k.close(); self.rx.close(); self.tx.close()
        for fd in self.fds: os.close(fd)
    def watch_process(self,pid):
        if pid in self.watched: return
        try: self.k.control([kevent_proc(pid)],0,0); self.watched.add(pid)
        except ProcessLookupError: self.exited.add(pid)
    def worker(self,fn):
        def run():
            try: self.http_result=('ok',fn())
            except Exception as e: self.http_result=('error',repr(e))
            try: self.tx.send(b'x')
            except OSError: pass
        threading.Thread(target=run,daemon=True).start()
    def events(self,block=True):
        events=self.k.control(None,64,None if block else 0)
        for ev in events:
            if ev.filter==select.KQ_FILTER_PROC: self.exited.add(ev.ident); note('observed process exit '+str(ev.ident))
            elif ev.filter==select.KQ_FILTER_READ: self.rx.recv(4096)
        return events
    def lines(self,name):
        p=LOGS/name
        try:
            f = p.open('rb')
        except FileNotFoundError:
            return []
        with f:
            st = os.fstat(f.fileno())
            prev = self.pos[name]
            same = prev and prev[:2] == [st.st_dev, st.st_ino]
            if same and st.st_size < prev[2]:
                raise RuntimeError('log shrank without an inode change: '+str(p))
            offset = prev[2] if same else 0
            if not same: self.pending[name] = b''
            f.seek(offset)
            data = f.read()
            end = f.tell()
        self.pos[name]=[st.st_dev,st.st_ino,end]
        parts=(self.pending[name]+data).split(b'\n'); self.pending[name]=parts.pop()
        return [x.decode(errors='replace') for x in parts]
    def scan(self):
        for line in self.lines('desktop.log'):
            m=re.search(r'\[desktop run=([^\]]+)\] pid=(\d+) port=(\d+) cwd=',line)
            if m:
                # Rotated files may contain prior launch lines: require a timestamp from this launch.
                t=re.search(r'\[([^]]+Z)\]',line)
                if not t: continue
                try: stamp=datetime.datetime.fromisoformat(t[1].replace('Z','+00:00')).timestamp()
                except ValueError: continue
                if stamp < self.launch_time: continue
                if self.pid and self.pid!=int(m[2]): raise RuntimeError('multiple backend spawns for launch')
                self.run,self.pid,self.port=m[1],int(m[2]),int(m[3])
                self.watch_process(self.pid); note('exact fresh spawn '+line)
        for line in self.lines('server.log'):
            if 'skipped-insufficient-space' in line or 'Continuing canonical forward migration without a pre-migration backup' in line:
                stamp_match=re.search(r'timestamp=([^ ]+)',line)
                if stamp_match:
                    try:
                        if datetime.datetime.fromisoformat(stamp_match[1].replace('Z','+00:00')).timestamp()<self.launch_time: continue
                    except ValueError: pass
                self.unsafe_no_backup=True
                save_json(U/'migration-without-backup.json', {'line':line})
                raise RuntimeError('migration ran without a backup')
            if 'database.migration.backup_ready' in line:
                t=re.search(r'timestamp=([^ ]+)',line)
                if not t:
                    self.observer_errors.append('backup event has no timestamp'); continue
                try: stamp=datetime.datetime.fromisoformat(t[1].replace('Z','+00:00')).timestamp()
                except ValueError:
                    self.observer_errors.append('backup event has an invalid timestamp'); continue
                if stamp<self.launch_time: continue
                try: obj=parse_backup(line)
                except Exception as e:
                    self.observer_errors.append(str(e)); note('OBSERVER issue '+str(e)); continue
                if obj:
                    backup_path = pathlib.Path(obj['backupPath'])
                    if backup_path.parent != self.backup_dir or backup_path.name in self.initial_backups:
                        raise RuntimeError('backup event does not name a new backup directory entry')
                    if self.backup is not None and self.backup != obj:
                        raise RuntimeError('multiple distinct migration backups observed for one launch')
                    self.backup=obj
                    save_json(U/'launch-backup-event.json',obj)
                    note('SAVED exact fresh migration event '+repr(obj))
    def runtime(self):
        try: obj=json.loads((D/'server-runtime.json').read_text())
        except (FileNotFoundError,ValueError): return None
        if obj.get('version')!=1 or obj.get('pid')!=self.pid or obj.get('port')!=self.port: return None
        try: started=datetime.datetime.fromisoformat(obj['startedAt'].replace('Z','+00:00')).timestamp()
        except (KeyError,ValueError,TypeError): return None
        if started<self.launch_time: return None
        origin=obj.get('origin')
        if origin not in (f'http://127.0.0.1:{self.port}',f'http://localhost:{self.port}'): raise RuntimeError('runtime origin mismatch')
        return origin
    def ready(self,app,expected,bounds):
        if not hasattr(self, 'launch_time'): self.launch_time=time.time()
        requested=False
        with OUT.open('ab') as out:
            note('LAUNCH detached retained output '+str(app/'Contents/MacOS/Penkra'))
            child=subprocess.Popen([str(app/'Contents/MacOS/Penkra')],stdout=out,stderr=subprocess.STDOUT,start_new_session=True,env=LAUNCH_ENV)
        self.child=child; self.watch_process(child.pid); note('app pid='+str(child.pid))
        while True:
            self.scan(); self.events(False)
            if child.poll() is not None or child.pid in self.exited: raise RuntimeError('app exited during startup')
            if self.pid in self.exited: raise RuntimeError('backend exited during startup')
            origin=self.runtime() if self.pid else None
            if origin and not requested:
                requested=True
                endpoint='/health' if expected=='0.14.3' else '/status'
                def request():
                    with urllib.request.urlopen(origin+endpoint) as response: return json.load(response)
                self.worker(request)
            if self.http_result:
                kind,status=self.http_result
                if kind=='error': raise RuntimeError('HTTP failed '+str(status))
                note('readiness response '+repr(status))
                if status.get('migration',{}).get('status')=='failed': raise RuntimeError('migration failed')
                ok=status.get('startupReady') is True if expected=='0.14.3' else status.get('version')==expected and status.get('migration',{}).get('status')=='ok'
                if not ok: raise RuntimeError('unexpected readiness JSON')
                self.scan(); self.events(False)
                if self.exited: raise RuntimeError('process exited racing readiness')
                if self.observer_errors: raise RuntimeError('Readiness established but migration event observer needs recovery: '+repr(self.observer_errors))
                if self.backup:
                    backup_path = pathlib.Path(self.backup['backupPath'])
                    try:
                        backup_stat = backup_path.lstat()
                    except FileNotFoundError:
                        raise RuntimeError('logged migration backup directory entry is missing: '+str(backup_path))
                    if not stat.S_ISREG(backup_stat.st_mode):
                        raise RuntimeError('backup directory entry is not a regular file: '+str(backup_path))
                    verify_db(backup_path); note('exact launch snapshot verified against new directory entry')
                return child.pid,self.pid,status
            self.events()

def verify_after_launch_helper_exit(app_pid, backend_pid, expected, launch_time):
    """Recheck the exact launched processes and readiness after their launcher exits."""
    monitor = Monitor(boundaries())
    try:
        monitor.watch_process(app_pid)
        monitor.watch_process(backend_pid)
        table = proc_table()
        executable = str(P / 'Contents/MacOS/Penkra')
        for pid in (app_pid, backend_pid):
            if table.get(pid) != executable:
                raise RuntimeError('exact process executable mismatch: '+str(pid))
        runtime = json.loads((D / 'server-runtime.json').read_text())
        if runtime.get('version') != 1 or runtime.get('pid') != backend_pid:
            raise RuntimeError('post-helper runtime PID mismatch')
        try:
            started_at = datetime.datetime.fromisoformat(runtime['startedAt'].replace('Z', '+00:00')).timestamp()
        except (KeyError, ValueError, TypeError):
            raise RuntimeError('post-helper runtime has invalid start time')
        if started_at < launch_time:
            raise RuntimeError('post-helper runtime predates this launch')
        port = runtime.get('port')
        origin = runtime.get('origin')
        if origin not in (f'http://127.0.0.1:{port}', f'http://localhost:{port}'):
            raise RuntimeError('invalid runtime origin')
        endpoint = '/health' if expected == '0.14.3' else '/status'
        def request():
            with urllib.request.urlopen(origin + endpoint) as response:
                return json.load(response)
        monitor.worker(request)
        while True:
            monitor.events(False)
            if monitor.exited:
                raise RuntimeError('process exited during post-helper verification')
            if monitor.http_result:
                state, result = monitor.http_result
                if state != 'ok':
                    raise RuntimeError('post-helper readiness failed: '+str(result))
                ready = (result.get('startupReady') is True if expected == '0.14.3' else
                         result.get('version') == expected and result.get('migration', {}).get('status') == 'ok')
                if not ready:
                    raise RuntimeError('post-helper readiness response was not ready')
                for pid in (app_pid, backend_pid):
                    os.kill(pid, 0)
                monitor.events(False)
                if monitor.exited:
                    raise RuntimeError('process exit raced post-helper readiness')
                return result
            monitor.events()
    finally:
        monitor.close()


def report(title,detail):
    final=f'{title}\n\n{detail}\n'
    (U/'report.md').write_text(final); note('REPORT '+final)
    cmd(['/usr/bin/osascript','-e',f'display notification {json.dumps(title+": "+detail[:100])} with title "Penkra update"'],gate=False)

def quit_all():
    ps=owners(); note('Production owner PIDs '+repr(ps))
    k=select.kqueue(); active=set()
    try:
        for pid in ps:
            try: k.control([kevent_proc(pid)],0,0); active.add(pid)
            except ProcessLookupError: pass
        if not IS_SCRATCH:
            cmd(['/usr/bin/osascript','-e','tell application "Penkra" to quit'],gate=False)
        else:
            # Scratch copies share the bundle identifier with Production.
            # Never ask Launch Services to quit by application name here.
            for pid in active:
                try: os.kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass
        while active:
            for ev in k.control(None,len(active),None):
                if ev.filter==select.KQ_FILTER_PROC: active.discard(ev.ident); note('owner exited pid='+str(ev.ident))
    finally: k.close()
    owners_now=lsof_db()
    remaining=owners()
    if remaining: raise RuntimeError('app processes still running '+repr(remaining))
    if owners_now: raise RuntimeError('database still has owners '+repr(owners_now))

def recover_database_after_failed_launch(backup):
    """Recover only from the exact backup recorded for this candidate launch."""
    marker = pathlib.Path(str(DB) + '.migration-recovery.json')
    if not backup:
        if marker.exists():
            raise RuntimeError('recovery marker exists without a launch backup event')
        note('no launch backup event: database unchanged by updater')
        return
    backup_path = pathlib.Path(backup['backupPath'])
    if backup.get('databasePath') != str(DB):
        raise RuntimeError('recovery event database path mismatch')
    if backup_path.parent != D / 'state.sqlite.backups':
        raise RuntimeError('recovery event backup path is outside the backup directory')
    if not stat.S_ISREG(backup_path.lstat().st_mode):
        raise RuntimeError('recovery backup is not a regular file')
    if marker.exists():
        payload = json.loads(marker.read_text())
        if payload.get('databasePath') != str(DB) or payload.get('backupPath') != str(backup_path):
            raise RuntimeError('migration marker does not match this launch backup')
        # The supported command prunes old failed-migration bundles and stale
        # *.restore files. Keep those artifacts outside its retention sweep.
        artifacts = [p for p in D.iterdir()
                     if p.name.startswith(DB.name + '.failed-migration-') or
                     (p.name.startswith(DB.name + '.') and p.name.endswith('.restore'))]
        if artifacts:
            retained = U / 'retained-migration-artifacts'
            retained.mkdir(exist_ok=False)
            for artifact in artifacts:
                shutil.move(str(artifact), str(retained / artifact.name))
                note('preserved pre-existing migration artifact '+str(artifact))
        env = os.environ.copy()
        env['ELECTRON_RUN_AS_NODE'] = '1'
        executable = C / 'Contents/MacOS/Penkra'
        script = C / 'Contents/Resources/app.asar/apps/server/dist/restoreMigrationBackup.mjs'
        cmd([str(executable), str(script), str(DB)], env=env)
        if marker.exists():
            raise RuntimeError('supported restore left the recovery marker present')
        note('supported restore completed for marked migration attempt')
        return
    verify_db(backup_path)
    failed_dir = U / 'failed-db'
    failed_dir.mkdir(exist_ok=False)
    for suffix in ('', '-wal', '-shm'):
        source = pathlib.Path(str(DB) + suffix)
        if source.exists():
            shutil.move(str(source), str(failed_dir / source.name))
            note('preserved failed database '+str(source))
    shutil.copy2(backup_path, DB)
    verify_db(DB)
    note('restored exact snapshot from committed migration: '+str(backup_path))


def scratch_database_fingerprint(path=None):
    """Capture the rehearsal criterion while the scratch database is closed."""
    path = DB if path is None else pathlib.Path(path)
    marker = pathlib.Path(str(DB) + '.migration-recovery.json')
    if marker.exists(): raise RuntimeError('scratch recovery marker remains')
    wal = pathlib.Path(str(path) + '-wal')
    # An empty or absent WAL needs no replay. Immutable mode avoids SQLite
    # trying to create a new shared-memory file merely to perform this check.
    uri = path.as_uri() + '?mode=ro'
    if not wal.exists() or wal.stat().st_size == 0: uri += '&immutable=1'
    connection = sqlite3.connect(uri, uri=True)
    try:
        integrity = [row[0] for row in connection.execute('PRAGMA integrity_check')]
        latest = connection.execute('SELECT max(migration_id) FROM effect_sql_migrations').fetchone()[0]
    finally:
        connection.close()
    if integrity != ['ok']: raise RuntimeError('scratch database integrity check failed: '+repr(integrity))
    digest = hashlib.sha256()
    process = subprocess.Popen(['/usr/bin/sqlite3', uri, '.dump'], stdout=subprocess.PIPE)
    try:
        while True:
            chunk = process.stdout.read(1024 * 1024)
            if not chunk: break
            digest.update(chunk)
    finally:
        process.stdout.close()
    if process.wait() != 0: raise RuntimeError('scratch database dump failed')
    return {'integrity': integrity[0], 'migration_id': latest, 'dump_sha256': digest.hexdigest()}


def rollback(oldversion, backup, reason):
    """One recovery path for failures during or after candidate launch."""
    note('CANDIDATE FAILURE '+repr(reason))
    quit_all()
    recover_database_after_failed_launch(backup)
    if SCRATCH_PROOF:
        before = json.loads((U/'scratch-before.json').read_text())
        after = scratch_database_fingerprint()
        save_json(U/'scratch-after-before-relaunch.json', after)
        if backup:
            expected = scratch_database_fingerprint(backup['backupPath'])
            save_json(U/'scratch-backup.json', expected)
            if after != expected: raise RuntimeError('scratch restore differs from the logged backup')
            note('scratch database matched the logged backup before old app relaunch')
        elif after['migration_id'] != before['migration_id']:
            raise RuntimeError('scratch migration ID changed without a backup event')
    if P.exists():
        shutil.move(str(P), str(FAILED))
        note('preserved failed bundle '+str(FAILED))
    shutil.move(str(OLD), str(P))
    note('restored old bundle')
    if SAVED.exists():
        shutil.move(str(SAVED), str(KEY))
        note('restored keybindings')
    mon = Monitor(boundaries())
    try:
        app_pid, backend_pid, status = mon.ready(P, oldversion, None)
        launch_time = mon.launch_time
    finally:
        mon.close()
    return ('rollback', app_pid, backend_pid, status, backup,
            {'oldversion': oldversion, 'reason': repr(reason)}, launch_time)


def relaunch_existing(oldversion, reason):
    """Recover an interrupted preflight that had already quit the old app."""
    quit_all()
    if version(P) != oldversion: raise RuntimeError('preflight app version changed')
    mon = Monitor(boundaries())
    try:
        app_pid, backend_pid, status = mon.ready(P, oldversion, None)
        launch_time = mon.launch_time
    finally:
        mon.close()
    return ('preflight', app_pid, backend_pid, status, None,
            {'oldversion': oldversion, 'reason': repr(reason)}, launch_time)


def supervise_result(result, launch_rollback):
    """Verify after the launch worker exits, rolling back on a failed recheck.

    launch_rollback must return only after the rollback launch worker has exited.
    The same recheck is then required for the restored application.
    """
    if not result or result[0] not in ('success', 'rollback', 'preflight') or len(result) != 7:
        raise RuntimeError('launch worker did not return a valid transaction result')
    kind, app_pid, backend_pid, _status, backup, detail, launch_time = result
    try:
        expected = version(C) if kind == 'success' else detail['oldversion']
        if kind == 'success' and SCRATCH_FAULT == 'post-helper':
            raise RuntimeError('forced scratch post-helper verification failure')
        if version(P) != expected:
            raise RuntimeError('installed bundle version changed before post-helper verification')
        status = verify_after_launch_helper_exit(app_pid, backend_pid, expected, launch_time)
    except Exception as error:
        if kind != 'success':
            raise RuntimeError('restored app failed post-helper verification: '+str(error)) from error
        note('candidate post-helper verification failed: '+repr(error))
        restored = launch_rollback(detail, backup, repr(error))
        if not restored or restored[0] != 'rollback' or len(restored) != 7:
            raise RuntimeError('rollback worker did not return a valid result')
        return supervise_result(restored, launch_rollback)
    return kind, app_pid, backend_pid, status, backup, detail, launch_time


def configure_scratch(config, config_path=None):
    """Reject configurations that can address the production app or profile."""
    global SCRATCH_FAULT, SCRATCH_PROOF
    root = pathlib.Path(config['root']).resolve(strict=True)
    SCRATCH_FAULT = config.get('fault')
    SCRATCH_PROOF = config.get('database_proof') is True
    if SCRATCH_FAULT not in (None, 'candidate-start', 'post-helper', 'migration-failure', 'migration-committed'):
        raise RuntimeError('unknown scratch fault')
    paths = {name: pathlib.Path(config[name]).resolve() for name in ('update', 'installed', 'userdata')}
    if (config_path is not None and config_path.parent != root) or any(not path.is_relative_to(root) for path in paths.values()):
        raise RuntimeError('scratch worker paths must all be inside the rehearsal root')
    production_home = (pathlib.Path.home() / 'Penkra').resolve()
    if root == production_home or production_home.is_relative_to(root) or root.is_relative_to(production_home):
        raise RuntimeError('scratch root overlaps Production data')
    if pathlib.Path('/Applications/Penkra.app').is_relative_to(root):
        raise RuntimeError('scratch root overlaps Production installation')
    scratch_home = root / 'home'
    expected_root = (scratch_home / 'Penkra').resolve()
    pointer = scratch_home / 'Library/Application Support/Penkra/root.json'
    pointer_root = pathlib.Path(json.loads(pointer.read_text())['root']).resolve()
    if pointer_root != expected_root or paths['userdata'] != expected_root / '.penkra/userdata':
        raise RuntimeError('scratch root pointer and userdata do not match')
    candidate = pathlib.Path(config['candidate']).resolve(strict=True)
    if candidate == paths['installed']:
        raise RuntimeError('candidate and installed scratch app must differ')
    env = os.environ.copy()
    env.update({'HOME': str(scratch_home), 'PENKRA_SKIP_LOGIN_SHELL_ENVIRONMENT': '1',
                'PENKRA_DESKTOP_SMOKE_USER_DATA': str(root / 'electron-profile'),
                'PENKRA_REHEARSAL_REAL_HOME': str(pathlib.Path.home())})
    configure(paths['update'], candidate,
              paths['installed'], paths['userdata'], env, scratch=True)
    return root


def prepare_scratch(root, candidate, snapshot, installed):
    """Make an isolated profile and copied app without modifying either source."""
    root = pathlib.Path(root).resolve()
    candidate = pathlib.Path(candidate).resolve(strict=True)
    snapshot = pathlib.Path(snapshot).resolve(strict=True)
    installed = pathlib.Path(installed).resolve(strict=True)
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    home = root / 'home'
    app_root = home / 'Penkra'
    userdata = app_root / '.penkra/userdata'
    logs = userdata / 'logs'
    backups = userdata / 'state.sqlite.backups'
    logs.mkdir(parents=True)
    backups.mkdir()
    update = root / 'update'
    update.mkdir()
    applications = root / 'Applications'
    applications.mkdir()
    pointer = home / 'Library/Application Support/Penkra/root.json'
    pointer.parent.mkdir(parents=True)
    pointer.write_text(json.dumps({'root': str(app_root)}))
    scratch_app = applications / 'Penkra.app'
    subprocess.run(['/bin/cp', '-cRp', str(installed), str(scratch_app)], check=True)
    subprocess.run(['/bin/cp', '-c', str(snapshot), str(userdata / 'state.sqlite')], check=True)
    # Seed only pinned executable generations, using copy-on-write clones;
    # connection credentials and the Production profile are never copied.
    runtime_root = pathlib.Path.home() / 'Penkra/.penkra/userdata/provider-runtimes'
    manifest = pathlib.Path(__file__).resolve().parents[2] / 'providerRuntimes.json'
    pinned = json.loads(manifest.read_text())['providers']
    for provider, release in pinned.items():
        version_name = release['version']
        if not re.fullmatch(r'[A-Za-z0-9._-]+', provider) or not re.fullmatch(r'[A-Za-z0-9._-]+', version_name):
            raise RuntimeError('invalid pinned provider runtime name')
        source = runtime_root / provider / 'versions' / version_name
        if source.is_dir() and not source.is_symlink():
            destination = userdata / 'provider-runtimes' / provider / 'versions'
            destination.mkdir(parents=True)
            subprocess.run(['/bin/cp', '-cRp', str(source), str(destination / version_name)], check=True)
    # The historical fixture predates the current space-icon vocabulary. Keep
    # its migration state intact, but make its scratch copy launchable.
    connection = sqlite3.connect(str(userdata / 'state.sqlite'))
    try:
        with connection:
            connection.execute("UPDATE projection_spaces SET icon='bag' WHERE icon='folder'")
    finally:
        connection.close()
    # Preflight parses an existing line. This one is synthetic and cannot be
    # mistaken for an event from the candidate launch because it predates the
    # monitored log boundary.
    event = {'databasePath': str(userdata / 'state.sqlite'),
             'backupPath': str(backups / 'preflight.sqlite'),
             'sourceVersion': 'v0', 'targetVersion': 1}
    (logs / 'desktop.log').write_text('')
    (logs / 'server.log').write_text('message=database.migration.backup_ready message=' +
                                     json.dumps(json.dumps(event)) + '\n')
    config = {'root': str(root), 'candidate': str(candidate), 'installed': str(scratch_app),
              'userdata': str(userdata), 'update': str(update)}
    save_json(root / 'scratch-config.json', config)
    configure_scratch(config)
    return config


def scratch_worker(config_path):
    """Run one launch worker only inside an explicitly isolated rehearsal tree."""
    config_path = pathlib.Path(config_path).resolve(strict=True)
    config = json.loads(config_path.read_text())
    root = configure_scratch(config, config_path)
    if config['action'] == 'transaction':
        result = main()
    elif config['action'] == 'rollback':
        result = rollback(config['oldversion'], config.get('backup'), config['reason'])
    elif config['action'] == 'relaunch-existing':
        result = relaunch_existing(config['oldversion'], config['reason'])
    else:
        raise RuntimeError('unknown scratch worker action')
    result_path = config_path.with_name(config_path.stem + '-result.json')
    temporary = result_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(result))
    os.replace(str(temporary), str(result_path))


def configure_production(config):
    """Bind only the canonical installation and its selected update folder."""
    global SCRATCH_FAULT, SCRATCH_PROOF
    SCRATCH_FAULT, SCRATCH_PROOF = None, False
    update = pathlib.Path(config['update']).resolve(strict=True)
    updates_root = (pathlib.Path.home()/'Penkra/.penkra/updates').resolve(strict=True)
    if update.parent != updates_root:
        raise RuntimeError('production update directory is not a direct child of updates')
    candidate = pathlib.Path(config['candidate']).resolve(strict=True)
    installed = pathlib.Path('/Applications/Penkra.app')
    if candidate == installed.resolve() or candidate.name != 'Penkra.app':
        raise RuntimeError('candidate must be a separate Penkra.app')
    userdata = (pathlib.Path.home()/'Penkra/.penkra/userdata').resolve(strict=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith('PENKRA_')}
    configure(update, candidate, installed, userdata, env)
    return update


def production_worker(config_path):
    """Worker entry, to be enabled only after the full scratch rehearsal."""
    config_path = pathlib.Path(config_path).resolve(strict=True)
    config = json.loads(config_path.read_text())
    update = configure_production(config)
    if config_path.parent != update: raise RuntimeError('worker config is outside update directory')
    if config['action'] == 'transaction':
        result = main()
    elif config['action'] == 'rollback':
        result = rollback(config['oldversion'], config.get('backup'), config['reason'])
    elif config['action'] == 'relaunch-existing':
        result = relaunch_existing(config['oldversion'], config['reason'])
    else:
        raise RuntimeError('unknown production worker action')
    save_json(config_path.with_name(config_path.stem + '-result.json'), result)


def run_scratch_worker(config, action, **extra):
    """Wait for a separate launch worker to exit before consuming its result."""
    root = pathlib.Path(config['root']).resolve(strict=True)
    fd, path = tempfile.mkstemp(prefix='worker-', suffix='.json', dir=str(root))
    config_path = pathlib.Path(path)
    with os.fdopen(fd, 'w') as file:
        json.dump({**config, **extra, 'action': action}, file)
        file.flush()
        os.fsync(file.fileno())
    result_path = config_path.with_name(config_path.stem + '-result.json')
    with (root / 'workers.log').open('ab') as output:
        child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()),
                                  '--scratch-worker', str(config_path)],
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        status = child.wait()
    if status or not result_path.is_file():
        raise RuntimeError('scratch '+action+' worker exited without a result (exit '+str(status)+')')
    return json.loads(result_path.read_text())


def run_production_worker(config, action, **extra):
    update = pathlib.Path(config['update']).resolve(strict=True)
    fd, path = tempfile.mkstemp(prefix='worker-', suffix='.json', dir=str(update))
    config_path = pathlib.Path(path)
    with os.fdopen(fd, 'w') as file:
        json.dump({**config, **extra, 'action': action}, file)
        file.flush()
        os.fsync(file.fileno())
    result_path = config_path.with_name(config_path.stem + '-result.json')
    with (update/'workers.log').open('ab') as output:
        child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()),
                                  '--production-worker', str(config_path)],
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        status = child.wait()
    if status or not result_path.is_file():
        raise RuntimeError('production '+action+' worker exited without a result (exit '+str(status)+')')
    return json.loads(result_path.read_text())


def supervise_transaction(config, run_worker):
    """Recover even if a launch worker exits without returning a result."""
    def launch_rollback(oldversion, backup, reason):
        return run_worker(config, 'rollback', oldversion=oldversion,
                          backup=backup, reason=reason)
    try:
        result = run_worker(config, 'transaction')
    except Exception as error:
        if not OLD.exists():
            preflight = U/'preflight-state.json'
            if not preflight.exists(): raise
            state = json.loads(preflight.read_text())
            result = run_worker(config, 'relaunch-existing', oldversion=state['oldversion'], reason=repr(error))
            return supervise_result(result, launch_rollback)
        note('transaction worker exited unexpectedly; recovering: '+repr(error))
        quit_all()
        state = json.loads((U/'transaction-state.json').read_text())
        launch_file = U/'launch-state.json'
        backup = None
        if launch_file.exists():
            launch = json.loads(launch_file.read_text())
            mon = Monitor(launch['bounds'])
            try:
                mon.initial_backups = set(launch['initial_backups'])
                mon.launch_time = launch['launch_time']
                mon.scan()
                if mon.observer_errors:
                    raise RuntimeError('migration event observation failed: '+repr(mon.observer_errors))
                backup = mon.backup
            finally:
                mon.close()
        result = launch_rollback(state['oldversion'], backup, repr(error))
    if result is None and (U/'report.md').is_file() and (U/'report.md').read_text().startswith('PREFLIGHT FAILED'):
        return None
    return supervise_result(result, launch_rollback)


def supervise_scratch_transaction(config):
    configure_scratch(config)
    return supervise_transaction(config, run_scratch_worker)


def supervise_production(config):
    """Run the transaction and write the final report outside the launch worker."""
    configure_production(config)
    try:
        result = supervise_transaction(config, run_production_worker)
        if result is None:
            return None
        kind, app_pid, backend_pid, status, backup, detail, _ = result
        title = ('UPDATE OK' if kind == 'success' else
                 'PREFLIGHT FAILED' if kind == 'preflight' else 'ROLLED BACK')
        detail_text = (f'Penkra {version(P)} is ready after the launch worker exited; '
                       f'app PID {app_pid}, backend PID {backend_pid}, status {status!r}. ')
        if backup:
            detail_text += 'Launch backup retained at '+backup['backupPath']+'. '
        else:
            detail_text += 'No migration backup event was recorded. '
        if kind == 'success':
            detail_text += 'Previous app retained at '+str(OLD)+'.'
        elif kind == 'rollback':
            detail_text += 'Rollback reason: '+str(detail.get('reason'))+'.'
        else:
            detail_text += 'Preflight interruption: '+str(detail.get('reason'))+'.'
        report(title, detail_text)
        return result
    except Exception as error:
        title = 'ROLLBACK INCOMPLETE' if (U/'transaction-state.json').exists() else 'PREFLIGHT FAILED'
        report(title, 'Inspect update.log and workers.log for the recovery state: '+str(error))
        raise


def start_production(candidate_path):
    """Start one detached supervisor, retaining output in its update folder."""
    candidate = pathlib.Path(candidate_path).expanduser().resolve(strict=True)
    updates = pathlib.Path.home()/'Penkra/.penkra/updates'
    updates.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-')
    update = pathlib.Path(tempfile.mkdtemp(prefix=stamp, dir=str(updates)))
    config = {'candidate': str(candidate), 'update': str(update)}
    configure_production(config)
    save_json(update/'supervisor-config.json', config)
    with (update/'supervisor.log').open('ab') as output:
        supervisor = subprocess.Popen(
            [sys.executable, str(pathlib.Path(__file__).resolve()),
             '--production-supervisor', str(update/'supervisor-config.json')],
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    print('Updater supervisor PID '+str(supervisor.pid)+'; report: '+str(update/'report.md'), flush=True)
    return update


def rehearse(directory):
    """Run all rollback branches on independently copied app/data trees."""
    candidate = os.environ.get('PENKRA_REHEARSAL_CANDIDATE')
    if not candidate:
        raise RuntimeError('set PENKRA_REHEARSAL_CANDIDATE to the candidate Penkra.app')
    fixture = pathlib.Path(__file__).resolve().parents[2] / 'apps/server/src/persistence/fixtures/pre-migration.sqlite'
    snapshot = pathlib.Path(os.environ.get('PENKRA_REHEARSAL_SNAPSHOT', str(fixture)))
    root = pathlib.Path(directory).expanduser().resolve()
    root.mkdir(mode=0o700, parents=False, exist_ok=True)
    if any(root.iterdir()): raise RuntimeError('rehearsal directory must be empty')
    results = {}
    for fault in ('candidate-start', 'migration-failure', 'migration-committed', 'post-helper'):
        case = root / fault
        config = prepare_scratch(case, candidate, snapshot, '/Applications/Penkra.app')
        config.update({'fault': fault, 'database_proof': True})
        result = supervise_scratch_transaction(config)
        if result[0] != 'rollback': raise RuntimeError('rehearsal did not roll back: '+fault)
        if bool(result[4]) != (fault in ('migration-failure', 'migration-committed', 'post-helper')):
            raise RuntimeError('unexpected backup event for rehearsal: '+fault)
        proof = json.loads((pathlib.Path(config['update'])/'scratch-after-before-relaunch.json').read_text())
        results[fault] = {'result': result, 'before_relaunch': proof}
        save_json(root/'results.json', results)
        # Each case has already reverified the restored app; stop it before
        # starting the next isolated profile to avoid competing app instances.
        configure_scratch(config)
        quit_all()
    return results


def main():
    note('START one-shot production update')
    moved=False; oldversion=None; candidate_hash=None; backup=None
    try:
        note('candidate version '+version(C))
        if version(C)!='0.14.6': raise RuntimeError('candidate version mismatch')
        if C.resolve() == P.resolve(): raise RuntimeError('candidate is the installed application')
        with (C/'Contents/Info.plist').open('rb') as source:
            if plistlib.load(source).get('CFBundleIdentifier') != 'com.penkra.app':
                raise RuntimeError('candidate bundle identity mismatch')
        quarantine = cmd(['/usr/bin/xattr','-p','com.apple.quarantine',str(C)],gate=False)
        if quarantine.returncode == 0: raise RuntimeError('candidate has quarantine attribute')
        cmd(['/usr/bin/codesign','--verify','--deep','--strict',str(C)])
        sign=cmd(['/usr/bin/codesign','--display','--verbose=4',str(C)]).stdout
        if 'Authority=Developer ID Application:' not in sign: raise RuntimeError('Developer ID missing')
        cmd(['/usr/sbin/spctl','--assess','--type','execute','-v',str(C)],gate=False)
        oldversion=version(P); note('installed version '+oldversion)
        note('bundle stat sizes candidate='+str(size(C))+' installed='+str(size(P)))
        for label,app in (('candidate',C),('installed',P)):
            total=sum(x.stat().st_size for x in app.rglob('*') if x.is_file())
            note(label+' total stat file bytes='+str(total))
        candidate_hash=sha(C/'Contents/Resources/app.asar'); note('candidate app.asar SHA256 '+candidate_hash)
        b=boundaries(); watcher_preflight(); note('hash API preflight completed')
        space_preflight()
        save_json(U/'preflight-state.json', {'oldversion': oldversion})
        quit_all()
        try:
            space_preflight()
            migration_preflight()
        except Exception as e:
            note('database preflight failed '+str(e))
            mon=Monitor(boundaries())
            try:
                ap,bp,st=mon.ready(P,oldversion,b)
                launch_time=mon.launch_time
            finally: mon.close()
            return ('preflight',ap,bp,st,None,
                    {'oldversion': oldversion, 'reason': 'database verification failed: '+str(e)},
                    launch_time)
        if SCRATCH_PROOF:
            save_json(U/'scratch-before.json', scratch_database_fingerprint())
        save_json(U/'transaction-state.json', {'oldversion': oldversion})
        note('MOVE old bundle '+str(P)+' -> '+str(OLD)); shutil.move(str(P),str(OLD)); moved=True
        try:
            cmd(['/usr/bin/ditto',str(C),str(P)])
            cmd(['/usr/bin/codesign','--verify','--deep','--strict',str(P)])
            sign=cmd(['/usr/bin/codesign','--display','--verbose=4',str(P)]).stdout
            if 'Authority=Developer ID Application:' not in sign: raise RuntimeError('installed Developer ID missing')
            if version(P)!='0.14.6': raise RuntimeError('installed version mismatch')
            installed_hash=sha(P/'Contents/Resources/app.asar')
            if installed_hash!=candidate_hash: raise RuntimeError('installed app.asar hash mismatch')
            note('installed app.asar SHA256 matches candidate '+installed_hash)
            cmd(['/usr/sbin/spctl','--assess','--type','execute','-v',str(P)],gate=False)
            if KEY.exists():
                note('MOVE keybindings '+str(KEY)+' -> '+str(SAVED)); shutil.move(str(KEY),str(SAVED))
            if SCRATCH_FAULT == 'candidate-start':
                raise RuntimeError('forced scratch candidate startup failure')
            launch_bounds = boundaries()
            mon=Monitor(launch_bounds)
            mon.launch_time = time.time()
            save_json(U/'launch-state.json', {'bounds': launch_bounds,
                      'initial_backups': sorted(mon.initial_backups),
                      'launch_time': mon.launch_time})
            if SCRATCH_FAULT in ('migration-failure', 'migration-committed'):
                bun = shutil.which('bun')
                if not bun: raise RuntimeError('scratch migration probe requires bun')
                probe = pathlib.Path(__file__).with_name('migration_probe.mjs')
                root = pathlib.Path(LAUNCH_ENV['HOME']).parent
                mode = 'fail' if SCRATCH_FAULT == 'migration-failure' else 'commit'
                cmd([bun, str(probe), str(root), str(DB), str(LOGS/'server.log'), mode], env=LAUNCH_ENV)
                raise RuntimeError('forced scratch failure after '+mode+' migration')
            ap,bp,st=mon.ready(P,'0.14.6',b); backup=mon.backup
            mon.close()
            note('helper exiting to verify persistence')
            return ('success',ap,bp,st,backup,oldversion,mon.launch_time)
        except Exception as e:
            note('CANDIDATE FAILURE '+repr(e))
            quit_all()
            if 'mon' in locals():
                try:
                    # Capture final records only after all writers have exited.
                    mon.scan(); backup=mon.backup
                    if mon.observer_errors: raise RuntimeError('migration event observation failed: '+repr(mon.observer_errors))
                finally: mon.close()
            if (U/'migration-without-backup.json').exists():
                raise RuntimeError('migration ran without a backup')
            return rollback(oldversion, backup, e)
    except Exception as e:
        note('FATAL '+repr(e))
        if not moved:
            report('PREFLIGHT FAILED',f'No bundle changed. Reason: {e}')
        else:
            report('ROLLBACK INCOMPLETE',f'Update failed; check update.log for exact recovery state. Reason: {e}')
        raise

if __name__=='__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--rehearse':
        print(json.dumps(rehearse(sys.argv[2]), indent=2))
        raise SystemExit(0)
    if len(sys.argv) == 3 and sys.argv[1] == '--scratch-worker':
        scratch_worker(sys.argv[2])
        raise SystemExit(0)
    if len(sys.argv) == 3 and sys.argv[1] == '--production-worker':
        production_worker(sys.argv[2])
        raise SystemExit(0)
    if len(sys.argv) == 3 and sys.argv[1] == '--production-supervisor':
        supervisor_config = json.loads(pathlib.Path(sys.argv[2]).read_text())
        supervise_production(supervisor_config)
        raise SystemExit(0)
    if len(sys.argv) == 3 and sys.argv[1] == '--production':
        start_production(sys.argv[2])
        raise SystemExit(0)
    raise SystemExit('usage: helper.py --rehearse <dir> | --production <Penkra.app>')
