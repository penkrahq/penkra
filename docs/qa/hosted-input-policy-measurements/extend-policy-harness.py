from pathlib import Path
import shutil
r=Path(Path('/tmp/penkra-policy-input-path').read_text())
for policy in ['A','B']:
 q=r/policy/'source/qa';f=q/'main.ts';shutil.copyfile(f,q/'main-primary-executed.ts');s=f.read_text();s=s.replace('ipcMain,session,protocol}', 'ipcMain,session,protocol,screen,webContents}')
 s=s.replace("await helper('cover',{x:b.X,y:b.Y,width:b.Width,height:b.Height})", "await helper('cover',{x:b.X,y:screen.getPrimaryDisplay().bounds.height-b.Y-b.Height,width:b.Width,height:b.Height})")
 s=s.replace(" caseId='enter-'+requestedState;", " if(process.env.QA_THROTTLING==='false'){for(const c of webContents.getAllWebContents())if(!c.isDestroyed())c.setBackgroundThrottling(false);trace('throttling-disabled',{ids:webContents.getAllWebContents().map(c=>c.id)})}\n caseId='enter-'+requestedState;")
 s=s.replace(" if(requestedState==='covered'){", " if(requestedState==='windowhidden'){shell.hide();await pause(900)}\n if(requestedState==='covered'){")
 s=s.replace("if(requestedState==='apphide'){app.hide();await pause(900)}}", "if(requestedState==='apphide'){app.hide();await pause(900)}if(requestedState==='windowhidden'){shell.hide();await pause(900)}}")
 s=s.replace("if(requestedState==='covered')await helper('hide');", "if(requestedState==='covered')await helper('hide');if(requestedState==='windowhidden'){shell.show();shell.focus()}")
 # Add native child-state to the copied diagnostic only; preserve original native handlers.
 s=s.replace("isFocused:win.isFocused()};trace(event,data);", "isFocused:win.isFocused(),ownerWindowId:host?.ownerWindowId('qa-A')??null,childViews:win.contentView.children.map(v=>({id:(v as any).webContents?.id,visible:v.getVisible(),bounds:v.getBounds()}))};trace(event,data);")
 # Page marker can distinguish a cached replica from live page if screen capture is permitted.
 s=s.replace(" caseId='return';trace", " await evaluate(\"document.body.style.background='rgb(255, 128, 0)'\");trace('live-page-color-marker',{rgb:[255,128,0]});\n caseId='return';trace")
 f.write_text(s)
 for state in ['covered']:
  d=r/policy/state;shutil.move(str(d/'evidence'),str(d/'excluded-partial-cover-evidence'));(d/'evidence').mkdir()
for policy,state in [('A','minimized-unthrottled'),('B','windowhidden')]:
 d=r/policy/state;(d/'evidence').mkdir(parents=True);(d/'qa-home').mkdir()
print(r)
