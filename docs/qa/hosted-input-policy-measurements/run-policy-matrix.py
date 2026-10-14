from pathlib import Path
import subprocess,os,time,json
r=Path(Path('/tmp/penkra-policy-input-path').read_text());order=[('B','apphide'),('A','apphide'),('B','covered'),('A','covered'),('B','space'),('A','space')];summary=[]
for policy,state in order:
 d=r/policy/state;src=r/policy/'source';print('START',policy,state,flush=True)
 control=d/'helper-control.json'
 if control.exists():control.unlink()
 env={**os.environ,'QA_ROOT':str(d),'PENKRA_HOME':str(d/'qa-home'),'PENKRA_PORT':'3919','VITE_DEV_SERVER_URL':'http://localhost:5919','QA_POLICY':policy,'QA_STATE':state}
 with (d/'evidence/electron.log').open('w') as log:
  child=subprocess.Popen([str(src/'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),'qa/bundle'],cwd=src,env=env,stdout=log,stderr=log)
  try:code=child.wait(timeout=480)
  except subprocess.TimeoutExpired:child.terminate();code='runner-timeout';child.wait(timeout=10)
 print('END',policy,state,code,flush=True);summary.append({'policy':policy,'state':state,'exit':code});(r/'runner-results.json').write_text(json.dumps(summary,indent=2))
 if code!=0:break
