from pathlib import Path
import subprocess,os,json
r=Path(Path('/tmp/penkra-policy-input-path').read_text());order=[('B','covered','covered','true'),('A','covered','covered','true'),('B','windowhidden','windowhidden','true'),('A','minimized-unthrottled','minimized','false')];summary=[]
for policy,label,state,throttle in order:
 d=r/policy/label;src=r/policy/'source';print('START',policy,label,flush=True)
 if (d/'helper-control.json').exists():(d/'helper-control.json').unlink()
 env={**os.environ,'QA_ROOT':str(d),'PENKRA_HOME':str(d/'qa-home'),'PENKRA_PORT':'3919','VITE_DEV_SERVER_URL':'http://localhost:5919','QA_POLICY':policy,'QA_STATE':state,'QA_THROTTLING':throttle}
 with (d/'evidence/electron.log').open('w') as log:
  child=subprocess.Popen([str(src/'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),'qa/bundle'],cwd=src,env=env,stdout=log,stderr=log)
  try:code=child.wait(timeout=480)
  except subprocess.TimeoutExpired:child.terminate();code='runner-timeout';child.wait(timeout=10)
 print('END',policy,label,code,flush=True);summary.append({'policy':policy,'label':label,'state':state,'throttling':throttle,'exit':code});(r/'supplement-results.json').write_text(json.dumps(summary,indent=2))
 if code!=0:break
