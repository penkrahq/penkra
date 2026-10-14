from pathlib import Path
r=Path(Path('/tmp/penkra-policy-input-path').read_text())
for policy in ['A','B']:
 f=r/policy/'source/qa/main.ts';s=f.read_text();s=s.replace("let caseId='bootstrap';","let shellVisibility='visible',pageVisibility='visible';let caseId='bootstrap';")
 s=s.replace("const trace=(event:string,data:any={})=>console.info('[qa]',{event,...data});","const trace=(event:string,data:any={})=>{if(data.documentVisibility)shellVisibility=data.documentVisibility;if(event==='page-event'&&data.visibility)pageVisibility=data.visibility;console.info('[qa]',{event,...data})};")
 a=s.index('async function state(){');b=s.index('\nasync function run()',a)
 s=s[:a]+'''async function state(){const page=host.target('qa-A','d2');return{epochMs:Date.now(),appHidden:app.isHidden(),shellVisible:shell.isVisible(),shellMinimized:shell.isMinimized(),shellFocused:shell.isFocused(),tabVisible:host.isVisible('qa-A'),ownerWindowId:host.ownerWindowId('qa-A'),childViews:shell.contentView.children.map(v=>({id:(v as any).webContents?.id,visible:v.getVisible()})),pageId:page.id,appId:host.target('qa-A','d1').id,shellDocument:{visibility:shellVisibility,source:'renderer visibility event cache'},pageDocument:{visibility:pageVisibility,source:'page visibility event cache'},presentation:{tabId:latest.tabId,mode:latest.mode,ownerWindowId:latest.ownerWindowId,appImage:!!latest.appFrameDataUrl,pageImage:!!latest.pageFrameDataUrl}}}'''+s[b:]
 s=s.replace("async function execute(command:string){", "async function execute(command:string){")
 # a bounded CDP evaluator uses the existing debug connection; avoids Electron executeJavaScript's hidden-frame wait.
 index=s.index(" async function sample(){")
 s=s[:index]+''' async function evaluate(expression:string){if(!page.debugger.isAttached())page.debugger.attach('1.3');const result:any=await page.debugger.sendCommand('Runtime.evaluate',{expression,returnByValue:true});return result.result?.value}
 async function recover(){trace('recovery-start');if(requestedState==='space'){shell.focus();await pause(1600)}else{app.show();shell.restore();shell.show();shell.focus();await pause(500)}trace('recovery-end')}
 async function reenter(){trace('reenter-state',{requestedState});if(requestedState==='space'){second!.focus();await pause(1600)}if(requestedState==='minimized'){shell.minimize();await pause(900)}if(requestedState==='apphide'){app.hide();await pause(900)}}
'''+s[index:]
 s=s.replace("await page.executeJavaScript(`window.qaReset(${JSON.stringify(id)})`,false)","await evaluate(`window.qaReset(${JSON.stringify(id)})`)")
 a=s.index("  const response=await execute(`penkra tabs act")
 b=s.index("\n }\n caseId='return'",a)
 s=s[:a]+'''  let returned:any=null;const startEpochMs=Date.now();const pending=execute(`penkra tabs act --input '${JSON.stringify({tabId:'qa-A',steps:[step]})}'`).then(v=>{returned=v;return v});const response=await Promise.race([pending,pause(30000).then(()=>({returned:false,ok:false,startedEpochMs:startEpochMs,error:{code:'QA_RESPONSE_DEADLINE',message:'No command response within 30 seconds; native state unchanged.'}}))]);
  const immediate=await evaluate('window.qaState()');await pause(1100);const afterPage=await evaluate('window.qaState()');const after=await sample();const event=afterPage.events.find((v:any)=>v.kind===(action==='type'?'input':action)&&v.caseId===id);const row:any={policy,requestedState,id,repetition,action,before,response,immediate,afterPage,after,event:event??null,pageDelayMs:event?event.epochMs-response.startedEpochMs:null};
  if(!response.returned){await recover();row.recoveryResponse=await Promise.race([pending,pause(5000).then(()=>({returned:false,error:'Still pending after recovery'}))]);row.recoveryPage=await evaluate('window.qaState()');row.recoveryState=await sample();await reenter()}
  trials.push(row);fs.writeFileSync(path.join(evidence,'trials.json'),JSON.stringify(trials,null,2));trace('trial-completed',row);
'''+s[b:]
 f.write_text(s)
print(r)
