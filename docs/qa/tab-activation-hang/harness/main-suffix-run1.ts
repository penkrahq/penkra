async function waitUntil(fn:()=>Promise<boolean>|boolean,label:string,limit=15000){const start=performance.now();while(performance.now()-start<limit){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error("QA wait timed out: "+label)}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function run(){
 await app.whenReady();
 const fixtureServer=http.createServer((req,res)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify({ok:true,result:folderTabs}));});
 await new Promise<void>(r=>fixtureServer.listen(3909,"127.0.0.1",r));
 shell=new BrowserWindow({width:1200,height:800,show:true,webPreferences:{preload:path.join(process.cwd(),"qa/preload.cjs"),contextIsolation:true,sandbox:true}});
 const window=shell; const rendererOwnerId=shell.webContents.id;
 WINDOW_EVENTS
 threadHomeWindow.view(shell.id,"qa-agent-thread","qa-folder",true,true);
 spacesMenuStateByShellRendererId.set(rendererOwnerId,{activeSpaceId:"qa-space"});
 appTabWindowFocusOrder.focus(shell.id);
 const browserPackage:any={appId:"com.penkra.browser",slug:"browser",name:"Browser",packagePath:process.cwd(),manifest:{entrypoints:{tab:"browser.html"},agentAddressable:true,permissions:[]}};
 const partition=createAppRendererPreferences({appId:"com.penkra.browser",spaceId:"qa-space",preloadPath:path.join(process.cwd(),"qa/app-preload.cjs")}).partition;
 await session.fromPartition(partition).protocol.handle("penkra-app",()=>new Response("<html><body style='background:#fff'>Local Browser fixture; no network/account</body></html>",{headers:{"Content-Type":"text/html"}}));
 const host=new AppTabViewHost({installations:{} as any,sessions:{get:()=>({origin:"penkra-app://a-"+"1".repeat(64)})} as any,broker:{registerTab:()=>()=>{}} as any,rpc:{registerTarget:()=>()=>{},request:async()=>({})} as any,ipcBridge:{waitForReady:async()=>{}} as any,preloadPath:path.join(process.cwd(),"qa/app-preload.cjs"),windowById:id=>id===rendererOwnerId?shell:null,hasShellWindow:()=>true,resolveIconDataUrl:async()=>null,onBeforeOpened:async()=>folderTabs,onOpened:()=>{},onRouteChanged:async()=>{},onCloseTab:async()=>{},onState:()=>{},onPresentation:(id,state)=>shell.webContents.send(IPC.appTabs.presentation,state)});
 desktopAppRuntime={appTabs:host};
 for(const tabId of ["qa-browser-A","qa-browser-B"]){await host.open({tabId,app:browserPackage,spaceId:"qa-space",folderId:"qa-folder",threadId:"qa-agent-thread",route:"/",initiator:"agent"} as any);}
 const tabs=host.list();
 folderTabs.tabs.panes=tabs.map(tab=>({id:tab.id,kind:"app",appId:tab.appId,appSpaceId:tab.spaceId,appSlug:tab.slug,appName:tab.name,appRoute:tab.route}));
 ipcMain.handle("qa-seed",()=>({folderTabs}));
 ipcMain.handle("qa-list",()=>tabs);
 ipcMain.on(IPC.appTabs.trace,(event,value)=>traceAppTab(value.event,{...value.details,rendererId:event.sender.id,tabId:value.tabId}));
 IPC_HANDLERS
 let rendererReady=false;
 ipcMain.on("qa-ready",()=>rendererReady=true);
 shell.webContents.on("console-message",(_e,level,message)=>diagnostic("renderer-console",{level,message}));
 await shell.loadURL("http://127.0.0.1:5909/qa.html");
 await waitUntil(()=>rendererReady,"renderer ready",90000); await pause(500);
 for(const tab of tabs)shell.webContents.send(IPC.appTabs.opened,{...tab,selection:"preserve",initiator:"agent"});
 await pause(700);
 const commandServer=new AppCommandPipeServer({path:path.join(qaRoot,"qa-home","commands.sock"),token:"qa-fixture-command-token",catalog:{} as any,broker:{} as any,tabs:host,activate:activateAppTabForAgent,presentation:appTabAgentPresentation,observer:{} as any,providerCredentialVault:{} as any});
 await commandServer.start();
 const results:any[]=[];
 const context={spaceId:"qa-space",folderId:"qa-folder",threadId:"qa-agent-thread",callerTurnId:"qa-turn"};
 async function setup(active:string,open:boolean){gate=null;shell.restore();shell.show();await host.setWindowVisibility(rendererOwnerId,true);await shell.webContents.executeJavaScript(`window.qa.setup(${JSON.stringify(active)},${open})`);await pause(500);if(open && !host.isVisible(active))await host.presentInWindow({tabId:active,folderId:"qa-folder",threadId:"qa-agent-thread",windowId:rendererOwnerId,bounds:{x:700,y:0,width:500,height:800},animate:false});await pause(250)}
 async function snapshot(){return {renderer:await shell.webContents.executeJavaScript("window.qa.state()"),visible:host.isVisible("qa-browser-A"),ownerId:host.ownerWindowId("qa-browser-A"),windowVisible:shell.isVisible(),windowMinimized:shell.isMinimized()}}
 for(const id of ["c-visible-other","a-collapsed-active","a-hidden-native-active","b-hide-after-claim","b-minimize-after-claim","d-already-hidden"]){
  caseId=id;
  await setup(id.startsWith("a-")?"qa-browser-A":"qa-browser-B",id!=="a-collapsed-active");
  if(id==="a-hidden-native-active")await host.hideInWindow("qa-browser-A",rendererOwnerId,false);
  if(id.startsWith("b-"))gate=makeGate();
  if(id==="d-already-hidden"){shell.hide();await pause(250);}
  const before=await snapshot();diagnostic("command-sent",{command:"penkra tabs activate --tab-id qa-browser-A",scope:context,before});
  const started=performance.now();
  const command=executePenkraExecCommand({command:"penkra tabs activate --tab-id qa-browser-A"},context,commandServer.environment).then(result=>({ok:true,result}),error=>({ok:false,error:{message:error.message,code:error.code,dispatched:error.dispatched}}));
  if(id.startsWith("b-")){
   await waitUntil(()=>{const lines=fs.readFileSync(logFile,"utf8").trim().split("\n");return lines.slice(-50).some(line=>{const row=JSON.parse(line);return row.caseId===id&&row.details.event==="presentation-gated"})},"claimed + presentation gate");
   if(id.includes("minimize"))shell.minimize();else shell.hide();
   await waitUntil(()=>!shell.isVisible()||shell.isMinimized(),"window hidden/minimized");await pause(100);diagnostic("gate-released",{windowVisible:shell.isVisible(),windowMinimized:shell.isMinimized()});gate!.release();gate=null;
  }
  const result=await command;
  const record={caseId:id,durationMs:performance.now()-started,command:"penkra tabs activate --tab-id qa-browser-A",scope:context,before,...result,after:await snapshot()};
  results.push(record);fs.writeFileSync(path.join(qaRoot,"evidence","results.json"),JSON.stringify(results,null,2));diagnostic("command-result",record);
  try{const image=await shell.webContents.capturePage();fs.writeFileSync(path.join(qaRoot,"evidence",id+".png"),image.toPNG())}catch{}
  await pause(300);
 }
 caseId="cleanup";host.closeAll();await commandServer.dispose();await new Promise<void>(r=>fixtureServer.close(()=>r()));shell.destroy();app.quit();
}
run().catch(error=>{console.error(error);fs.writeFileSync(path.join(qaRoot,"evidence","failure.txt"),error.stack??String(error));app.exit(1)});
