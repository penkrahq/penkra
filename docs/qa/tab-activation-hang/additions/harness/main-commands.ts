import {app,BrowserWindow,ipcMain,session,protocol,webContents} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import {AppTabActivation} from "../apps/desktop/src/appTabActivation";
import {AppTabViewHost} from "../apps/desktop/src/appTabViewHost";
import {AppCommandPipeServer} from "../apps/desktop/src/appCommandPipeServer";
import {DESKTOP_IPC_CHANNELS} from "../apps/desktop/src/ipcChannels";
import {announceAppTabOpened as routeAppTabOpened,AppTabWindowFocusOrder,appTabFolderUnavailable} from "../apps/desktop/src/appTabOpenedRouting";
import {ThreadHomeWindow} from "../apps/desktop/src/threadHomeWindow";
import {PanelFocusState} from "../apps/desktop/src/panelFocus";
import {readDesktopFolderAppTabs} from "../apps/desktop/src/desktopFolderAppTabsClient";
import {createAppRendererPreferences} from "../apps/desktop/src/appRuntimePolicy";
import {executePenkraExecCommand} from "../apps/server/src/appRuntimeCli";

type DesktopAppTabDescriptor=any; type DesktopAppTabOpened=any;
const qaRoot=process.env.QA_ROOT!;
app.setPath("userData",path.join(qaRoot,"qa-home"));
app.setPath("sessionData",path.join(qaRoot,"qa-home"));
app.setName("Penkra activation diagnostic harness");
protocol.registerSchemesAsPrivileged([{scheme:"penkra-app",privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let caseId="bootstrap";
const logFile=path.join(qaRoot,"evidence","events.jsonl");
const originalInfo=console.info.bind(console);
console.info=(tag:any,details:any={})=>{fs.appendFileSync(logFile,JSON.stringify({caseId,observedAtMs:performance.now(),tag,details})+"\n");originalInfo(tag,details)};
const diagnostic=(event:string,details:any={})=>console.info("[qa-control]",{event,...details});
const IPC=DESKTOP_IPC_CHANNELS;
const threadHomeWindow=new ThreadHomeWindow();
const appTabWindowFocusOrder=new AppTabWindowFocusOrder();
const panelFocusState=new PanelFocusState();
const appTabActivation=new AppTabActivation();
const spacesMenuStateByShellRendererId=new Map<number,any>();
let desktopAppRuntime:any;
let shell:BrowserWindow;
const shellWindows=()=>shell && !shell.isDestroyed() ? [shell] : [];
const backendHttpUrl="http://127.0.0.1:3919";
const DESKTOP_BACKEND_SHUTDOWN_TOKEN="qa-fixture-backend-token";
const formatErrorMessage=(e:any)=>String(e?.message??e);
let appTabDiagnosticSequence=0;
let folderTabs:any={folderId:"qa-folder",folderTitle:"QA folder",updatedAt:"2026-10-14T00:00:00.000Z",tabs:{panes:[]}};
let gate:{promise:Promise<void>;release:()=>void}|null=null;
function makeGate(){let release!:()=>void; const promise=new Promise<void>(r=>release=r);return {promise,release}}
function requireShellAppTabs(id:number){if(id!==shell.webContents.id)throw new Error("Not the QA shell");return desktopAppRuntime.appTabs}
async function presentAppTabInWindow(input:any){if(gate){diagnostic("presentation-gated",input);await gate.promise;}await desktopAppRuntime.appTabs.presentInWindow(input);}
async function hideAppTabInWindow(tabId:string,windowId:number,animate:boolean){await desktopAppRuntime.appTabs.hideInWindow(tabId,windowId,animate)}
async function setAppTabWindowVisibility(windowId:number,visible:boolean){await desktopAppRuntime.appTabs.setWindowVisibility(windowId,visible)}

let claimGate:any=null;
const originalClaim=appTabActivation.claim.bind(appTabActivation);
(appTabActivation as any).claim=(requestId:string,windowId:number)=>{
 const finish=()=>{const accepted=originalClaim(requestId,windowId);diagnostic("activation-claim-result",{requestId,windowId,accepted});return accepted};
 if(claimGate){diagnostic("activation-claim-gated",{requestId,windowId});return claimGate.promise.then(finish)}
 return finish();
};

import {AppTabObserver} from "../apps/desktop/src/appTabObserver";
import {resolveBrowserUploadFile} from "../apps/desktop/src/browserUploadFile";
import {EventEmitter} from "node:events";
const presentationEvents=new EventEmitter();
function routeAppTab(
  descriptor: Pick<DesktopAppTabOpened, "threadId" | "folderId" | "spaceId" | "initiator">,
) {
  return routeAppTabOpened({
    descriptor,
    windows: appTabWindowFocusOrder.order(
      shellWindows()
        .filter((window) => !window.isDestroyed() && !window.webContents.isLoadingMainFrame())
        .map((window) => {
          const snapshot = threadHomeWindow.snapshot(window.id);
          return {
            id: window.id,
            focused: window.isFocused(),
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            spaceId:
              spacesMenuStateByShellRendererId.get(window.webContents.id)?.activeSpaceId ?? null,
            folderId:
              snapshot?.views.find((view) => view.threadId === snapshot.activeThreadId)?.folderId ??
              null,
          };
        }),
    ),
    home: threadHomeWindow,
    panelFocus: panelFocusState,
  });
}
function appTabAgentPresentation(
  tab: DesktopAppTabDescriptor,
  _threadId: string,
): { state: "active" | "background" | "window-hidden" } {
  const tabs = desktopAppRuntime!.appTabs;
  const ownerId = tabs.ownerWindowId(tab.id);
  const window = shellWindows().find((candidate) => candidate.webContents.id === ownerId);
  if (!window || !window.isVisible() || window.isMinimized()) return { state: "window-hidden" };
  return {
    state:
      tabs.ownerWindowId(tab.id) === window.webContents.id && tabs.isVisible(tab.id)
        ? "active"
        : "background",
  };
}

async function activateAppTabForAgent(
  tab: DesktopAppTabDescriptor,
  threadId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const route = routeAppTab({ ...tab, threadId, initiator: "agent" });
  const window = shellWindows().find((candidate) => candidate.id === route.targetWindowId);
  if (!backendHttpUrl) throw new Error("The backend is not ready.");
  const folderTabs = await readDesktopFolderAppTabs(
    { url: backendHttpUrl, token: DESKTOP_BACKEND_SHUTDOWN_TOKEN },
    tab.folderId,
  );
  if (!folderTabs) throw new Error("The folder is not available.");
  if (!window) throw appTabFolderUnavailable(folderTabs.folderTitle, route.folderShown);
  if (
    desktopAppRuntime!.appTabs.ownerWindowId(tab.id) !== window.webContents.id ||
    !desktopAppRuntime!.appTabs.isVisible(tab.id)
  ) {
    await appTabActivation.request(
      tab.id,
      window.webContents.id,
      signal,
      () => routeAppTab({ ...tab, threadId, initiator: "agent" }).targetWindowId === window.id,
      (request) => {
        window.webContents.send(IPC.appTabs.activationRequested, {
          requestId: request.requestId,
          tab,
          folderTabs,
        });
      },
    );
  }
  signal.throwIfAborted();
  if (
    desktopAppRuntime!.appTabs.ownerWindowId(tab.id) !== window.webContents.id ||
    !desktopAppRuntime!.appTabs.isVisible(tab.id)
  ) {
    throw Object.assign(new Error("The tab lost presentation during activation."), {
      code: "TAB_NOT_ACTIVE",
      dispatched: false,
    });
  }
  return { tabId: tab.id, state: "active", readyForInteraction: true };
}

function traceAppTab(event: string, details: Record<string, unknown> = {}): void {
  console.info("[app-tab-diagnostic]", {
    ...details,
    sequence: ++appTabDiagnosticSequence,
    monotonicMs: Math.round(performance.now()),
    event,
  });
}

function traceAppTabWindow(window: BrowserWindow, event: string): void {
  const details = {
    browserWindowId: window.id,
    rendererId: window.webContents.id,
    isVisible: window.isVisible(),
    isMinimized: window.isMinimized(),
    isFocused: window.isFocused(),
  };
  void window.webContents
    .executeJavaScript(
      "({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })",
    )
    .then((rendererState: unknown) => traceAppTab(event, { ...details, rendererState }))
    .catch((error: unknown) => {
      traceAppTab(event, { ...details, rendererStateError: formatErrorMessage(error) });
    });
}


async function waitUntil(fn:()=>Promise<boolean>|boolean,label:string,limit=15000){const start=performance.now();while(performance.now()-start<limit){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw new Error("QA wait timed out: "+label)}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function run(){
 await app.whenReady();
 const fixtureServer=http.createServer((req,res)=>{if(req.url?.startsWith('/probe')){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(process.cwd(),'qa/probe.html')));return}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:folderTabs}));});
 await new Promise<void>((resolve,reject)=>{fixtureServer.once('error',reject);fixtureServer.listen(3919,'127.0.0.1',resolve)});
 shell=new BrowserWindow({width:1200,height:800,show:true,webPreferences:{preload:path.join(process.cwd(),'qa/preload.cjs'),contextIsolation:true,sandbox:true}});
 const window=shell;const rendererOwnerId=shell.webContents.id;
   window.on("hide", () => {
    traceAppTabWindow(window, "shell-window-hide");
    void setAppTabWindowVisibility(rendererOwnerId, false);
  });
  window.on("show", () => {
    traceAppTabWindow(window, "shell-window-show");
    void setAppTabWindowVisibility(rendererOwnerId, true);
  });
  window.on("minimize", () => {
    traceAppTabWindow(window, "shell-window-minimize");
    void setAppTabWindowVisibility(rendererOwnerId, false);
  });
  window.on("restore", () => {
    traceAppTabWindow(window, "shell-window-restore");
    void setAppTabWindowVisibility(rendererOwnerId, true);
  });

 threadHomeWindow.view(shell.id,'qa-agent-thread','qa-folder',true,true);spacesMenuStateByShellRendererId.set(rendererOwnerId,{activeSpaceId:'qa-space'});appTabWindowFocusOrder.focus(shell.id);
 const browserPackage:any={appId:'com.penkra.browser',slug:'browser',name:'Browser',packagePath:process.cwd(),manifest:{entrypoints:{tab:'browser.html'},agentAddressable:true,permissions:[]}};
 const partition=createAppRendererPreferences({appId:'com.penkra.browser',spaceId:'qa-space',preloadPath:path.join(process.cwd(),'qa/app-preload.cjs')}).partition;
 await session.fromPartition(partition).protocol.handle('penkra-app',()=>new Response('<html><body>Local Browser toolbar fixture</body></html>',{headers:{'Content-Type':'text/html'}}));
 const host=new AppTabViewHost({installations:{} as any,sessions:{get:()=>({origin:'penkra-app://a-'+"1".repeat(64)})} as any,broker:{registerTab:()=>()=>{}} as any,rpc:{registerTarget:()=>()=>{},request:async()=>({})} as any,ipcBridge:{waitForReady:async()=>{}} as any,preloadPath:path.join(process.cwd(),'qa/app-preload.cjs'),windowById:id=>id===rendererOwnerId?shell:null,hasShellWindow:()=>true,resolveIconDataUrl:async()=>null,onBeforeOpened:async()=>folderTabs,onOpened:()=>{},onRouteChanged:async()=>{},onCloseTab:async()=>{},onState:()=>{},onPresentation:(id,state)=>{shell.webContents.send(IPC.appTabs.presentation,state);presentationEvents.emit(state.tabId)}});
 desktopAppRuntime={appTabs:host};
 for(const tabId of ['qa-browser-A','qa-browser-B'])await host.open({tabId,app:browserPackage,spaceId:'qa-space',folderId:'qa-folder',threadId:'qa-agent-thread',route:'/',initiator:'agent'} as any);
 const tabs=host.list();folderTabs.tabs.panes=tabs.map(tab=>({id:tab.id,kind:'app',appId:tab.appId,appSpaceId:tab.spaceId,appSlug:tab.slug,appName:tab.name,appRoute:tab.route}));
 ipcMain.handle('qa-seed',()=>({folderTabs}));ipcMain.handle('qa-list',()=>tabs);ipcMain.on(IPC.appTabs.trace,(event,value)=>traceAppTab(value.event,{...value.details,rendererId:event.sender.id,tabId:value.tabId}));
   ipcMain.handle(IPC.appTabs.claimActivation, async (event, requestId: unknown) => {
    requireShellAppTabs(event.sender.id);
    return typeof requestId === "string" && appTabActivation.claim(requestId, event.sender.id);
  });
  ipcMain.handle(
    IPC.appTabs.failActivation,
    async (event, requestId: unknown, message: unknown) => {
      requireShellAppTabs(event.sender.id);
      if (typeof requestId !== "string" || typeof message !== "string")
        throw new Error("Invalid App tab activation failure.");
      appTabActivation.fail(requestId, event.sender.id, message);
    },
  );
  ipcMain.handle(IPC.appTabs.present, async (event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const { tabId, folderId, threadId, animate, animationStartedAtEpochMs, bounds } =
      input as Record<string, unknown>;
    if (
      typeof tabId !== "string" ||
      typeof folderId !== "string" ||
      typeof threadId !== "string" ||
      !bounds ||
      typeof bounds !== "object" ||
      Array.isArray(bounds)
    ) {
      throw new Error("Invalid App view presentation request.");
    }
    requireShellAppTabs(event.sender.id);
    const appBounds = bounds as Electron.Rectangle;
    traceAppTab("shell-present-ipc", {
      tabId,
      rendererId: event.sender.id,
      folderId,
      threadId,
      animate: animate === true,
      bounds: appBounds,
    });
    await presentAppTabInWindow({
      tabId,
      folderId,
      threadId,
      windowId: event.sender.id,
      bounds: appBounds,
      animate: animate === true,
      ...(typeof animationStartedAtEpochMs === "number" &&
      Number.isFinite(animationStartedAtEpochMs)
        ? { animationStartedAtEpochMs }
        : {}),
    });
    if (desktopAppRuntime?.appTabs.isVisible(tabId))
      appTabActivation.presented(tabId, event.sender.id);
  });
  ipcMain.handle(IPC.appTabs.hide, async (event, input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const { tabId, animate } = input as Record<string, unknown>;
    if (typeof tabId !== "string") return;
    if (animate !== undefined && typeof animate !== "boolean") return;
    const tabs = requireShellAppTabs(event.sender.id);
    if (tabs.has(tabId)) {
      traceAppTab("shell-hide-ipc", {
        tabId,
        rendererId: event.sender.id,
        animate: animate === true,
      });
      await hideAppTabInWindow(tabId, event.sender.id, animate === true);
    }
  });

 let rendererReady=false;ipcMain.on('qa-ready',()=>rendererReady=true);
 shell.webContents.on('console-message',(_event,level,message)=>diagnostic('renderer-console',{level,message}));
 await shell.loadURL('http://127.0.0.1:5919/qa.html');await waitUntil(()=>rendererReady,'renderer ready',90000);await pause(500);for(const tab of tabs)shell.webContents.send(IPC.appTabs.opened,{...tab,selection:'preserve',initiator:'agent'});await pause(700);
 await host.openHostedPage('qa-browser-A','http://127.0.0.1:3919/probe');
 const page=host.target('qa-browser-A','d2');
 const originalCdpSend=page.debugger.sendCommand.bind(page.debugger);(page.debugger as any).sendCommand=(method:string,params:any,sessionId:any)=>{if(['DOM.setFileInputFiles','Input.dispatchMouseEvent','Runtime.callFunctionOn'].includes(method))console.info('[qa-cdp-request]',{method,params,sessionId});return originalCdpSend(method,params,sessionId)};
 page.on('console-message',(event:any,level?:any,message?:any)=>{const text=event.message??message??'';if(text.startsWith('QA_PAGE_EVENT ')){const row=JSON.parse(text.slice(14));console.info('[qa-page-event]',row)}});
 const observer=new AppTabObserver({resolve:(tabId,document,surfaceId)=>{const descriptor=host.list().find(row=>row.id===tabId);if(!descriptor)throw Object.assign(new Error(`App tab ${tabId} is gone.`),{code:'TAB_GONE'});return{descriptor,document,webContents:host.target(tabId,document),isPresented:()=>surfaceId!==null&&shell.isVisible()&&!shell.isMinimized()&&host.ownerWindowId(tabId)===rendererOwnerId&&host.isVisible(tabId),onPresentationChange:listener=>{presentationEvents.on(tabId,listener);return()=>presentationEvents.off(tabId,listener)},canDeliverPointerInput:()=>host.canDeliverPointerInput(tabId)}},validateUploadPaths:async(_descriptor,paths)=>Promise.all(paths.map(file=>resolveBrowserUploadFile(file,path.join(qaRoot,'app-storage'))))});
 const commandServer=new AppCommandPipeServer({path:path.join(qaRoot,'qa-home','commands.sock'),token:'qa-fixture-command-token',catalog:{} as any,broker:{} as any,tabs:host,activate:activateAppTabForAgent,presentation:appTabAgentPresentation,observationSurface:()=>rendererOwnerId,observer,providerCredentialVault:{} as any});await commandServer.start();
 const context={spaceId:'qa-space',folderId:'qa-folder',threadId:'qa-agent-thread',callerTurnId:'qa-turn',cwd:path.join(qaRoot,'evidence')};
 const results:any[]=[];
 async function execute(command:string,id:string,overrideContext:any=context){const startedEpochMs=Date.now(),started=performance.now();diagnostic('command-sent',{command,id,startedEpochMs});const response=await executePenkraExecCommand({command},overrideContext,commandServer.environment).then(result=>({ok:true,result}),error=>({ok:false,error:{message:error.message,code:error.code,dispatched:error.dispatched,outcome:error.outcome,failedStep:error.failedStep,completedSteps:error.completedSteps}}));const row={caseId,id,command,startedEpochMs,durationMs:performance.now()-started,...response};results.push(row);fs.writeFileSync(path.join(qaRoot,'evidence','command-results.json'),JSON.stringify(results,null,2));diagnostic('command-result',row);return row}
 const pageState=()=>page.executeJavaScript('window.qaState()',false);
 async function show(){app.show();shell.restore();shell.show();await waitUntil(()=>shell.isVisible()&&!shell.isMinimized(),'visible');await host.setWindowVisibility(rendererOwnerId,true);await shell.webContents.executeJavaScript('window.qa.setup("qa-browser-A",true)');await host.presentInWindow({tabId:'qa-browser-A',folderId:'qa-folder',threadId:'qa-agent-thread',windowId:rendererOwnerId,bounds:{x:650,y:0,width:550,height:800},animate:false});await pause(300)}
 async function setMode(mode:string,throttling:boolean){await show();for(const contents of webContents.getAllWebContents())if(!contents.isDestroyed())contents.setBackgroundThrottling(throttling);if(mode==='hidden')shell.hide();if(mode==='minimized')shell.minimize();if(mode!=='visible')await waitUntil(()=>!shell.isVisible()||(mode==='minimized'&&shell.isMinimized()),mode);await pause(500);return{mode,shellVisible:shell.isVisible(),minimized:shell.isMinimized(),hostVisible:host.isVisible('qa-browser-A'),pageVisibility:await page.executeJavaScript('document.visibilityState'),throttling:webContents.getAllWebContents().map(c=>({id:c.id,value:c.getBackgroundThrottling()}))}}
 const states:any[]=[];
 for(const mode of ['visible','hidden','minimized'])for(const throttling of [true,false])for(const bypass of mode==='visible'?[false]:[false,true]){
  caseId=`f-${mode}-throttle-${throttling}-bypass-${bypass}`;process.env.QA_BYPASS_TAB_GUARD=bypass?'1':'0';const before=await setMode(mode,throttling);await page.executeJavaScript(`window.qaReset(${JSON.stringify(caseId)})`);
  const snapshot=await execute('penkra tabs snapshot --tab-id qa-browser-A --document d2',caseId+'-snapshot');
  const refs:any=(snapshot as any).result?.refs??{};const find=(name:string)=>Object.entries(refs).find(([key,value]:any)=>value.name===name)?.[0];
  const click=find('Click probe'),type=find('Text probe'),upload=find('Upload probe');if(!click||!type||!upload)throw new Error('QA missing references '+JSON.stringify(refs));
  const commandRows:any[]=[];
  for(const step of [{action:'click',ref:click},{action:'type',ref:type,text:'typed-'+caseId},{action:'scroll',document:'d2',deltaY:400},{action:'upload',ref:upload,paths:[path.join(qaRoot,'app-storage','upload-fixture.txt')]}]){
   const actionId=`${caseId}-${step.action}`;await page.executeJavaScript(`window.qaCase=${JSON.stringify(actionId)}`);const row=await execute(`penkra tabs act --input '${JSON.stringify({tabId:'qa-browser-A',steps:[step]})}'`,actionId);const immediate=await pageState();await pause(1000);const delayed=await pageState();commandRows.push({actionId,response:row,immediate,afterOneSecond:delayed});
  }
  await pause(3000);const beforeRestore=await pageState();const hiddenEnd={visible:shell.isVisible(),minimized:shell.isMinimized()};await show();await pause(1000);const afterRestore=await pageState();const state={caseId,before,commandRows,beforeRestore,hiddenEnd,afterRestore};states.push(state);fs.writeFileSync(path.join(qaRoot,'evidence','event-delivery-matrix.json'),JSON.stringify(states,null,2));
 }
 caseId='g-help';process.env.QA_BYPASS_TAB_GUARD='0';await show();
 fs.mkdirSync(path.join(qaRoot,'evidence','help'),{recursive:true});
 for(const sub of ['', 'list','activate','close','snapshot','act','evaluate','screenshot','record','trace','har']){const command=`penkra tabs${sub?' '+sub:''} --help`;const row=await execute(command,'help-'+(sub||'root'));fs.writeFileSync(path.join(qaRoot,'evidence','help',(sub||'root')+'.json'),JSON.stringify(row,null,2));}
  caseId='g-behavior';
 const snapshotCommand='penkra tabs snapshot --tab-id qa-browser-A --document d2';
 let gs=await execute(snapshotCommand,'g-initial-snapshot');
 const reference=(name:string)=>(Object.entries((gs as any).result?.refs??{}).find(([key,value]:any)=>value.name===name)?.[0]);
 const actStep=(step:any)=>`penkra tabs act --input '${JSON.stringify({tabId:'qa-browser-A',steps:[step]})}'`;
 await execute('penkra tabs list','g-list-active');
 await execute('penkra tabs list','g-list-other-folder',{...context,folderId:'qa-other-folder'});
 await execute(snapshotCommand,'g-same-folder-other-thread',{...context,threadId:'qa-other-thread'});
 for(const command of ['penkra tabs unknown','penkra tabs snapshot','penkra tabs snapshot --tab-id qa-browser-A --document d3','penkra tabs snapshot --tab-id qa-browser-A --document d2 --depth -1','penkra tabs snapshot --tab-id qa-browser-A --document d2 --depth 0.5','penkra tabs snapshot --tab-id qa-browser-A --document d2 --boxes maybe','penkra tabs snapshot --help --tab-id qa-browser-A','penkra tabs snapshot --tab-id qa-browser-A --document d2 --unknown hi','penkra tabs act --tab-id qa-browser-A','penkra tabs act --input \'{"tabId":"qa-browser-A","steps":[]}\'','penkra tabs act --input \'{"tabId":"qa-browser-A","steps":[{"action":"unknown"}]}\'','penkra tabs snapshot --tab-id missing --document d2'])await execute(command,'g-parse-'+results.length);
 await execute(actStep({action:'click',ref:reference('Covered probe')}),'g-covered-target');
 await execute(actStep({action:'upload',ref:reference('Click probe'),paths:[path.join(qaRoot,'app-storage','upload-fixture.txt')]}),'g-upload-not-file-input');
 await execute(actStep({action:'upload',ref:reference('Upload probe'),paths:[path.join(qaRoot,'app-storage')]}),'g-upload-directory');
 await execute(actStep({action:'upload',ref:reference('Upload probe'),paths:[path.join(qaRoot,'app-storage','missing.txt')]}),'g-upload-missing');
 await execute('penkra tabs snapshot --tab-id qa-browser-A --document d2 --filename saved-snapshot.txt','g-save-snapshot');
 await execute('penkra tabs evaluate --tab-id qa-browser-A --document d2 --expression \'({title:document.title,visibility:document.visibilityState})\'','g-evaluate-serializable');
 await execute(`penkra tabs act --input '${JSON.stringify({tabId:'qa-browser-A',steps:[{action:'click',ref:reference('Click probe')},{action:'click',ref:'d2:e999999'}]})}'`,'g-partial-sequence');
 const oldRef=reference('Click probe');
 await host.navigateHostedPage('qa-browser-A',undefined,'http://127.0.0.1:3919/probe?next-loader');
 await execute(actStep({action:'click',ref:oldRef}),'g-old-loader-reference');
 gs=await execute(snapshotCommand,'g-new-loader');
 await shell.webContents.executeJavaScript('window.qa.setup("qa-browser-B",true)');await pause(400);
 await execute('penkra tabs screenshot --tab-id qa-browser-A --document d2 --filename selected-A.png','g-screenshot-different-tab');
 diagnostic('screenshot-selection-after',{activeNative:host.current()?.id,renderer:await shell.webContents.executeJavaScript('window.qa.state()')});
 await execute('penkra tabs record --tab-id qa-browser-A --document d2 --duration-ms 500 --filename qa-record.webm','g-record-webm');
 await execute('penkra tabs record --tab-id qa-browser-A --document d2 --duration-ms 100 --filename wrong.bin','g-record-extension');
 await execute('penkra tabs trace --tab-id qa-browser-A --document d2 --duration-ms 500 --filename trace.json','g-trace');
 await execute('penkra tabs har --tab-id qa-browser-A --document d2 --duration-ms 300 --filename visible.har','g-har-visible');
 await setMode('hidden',false);process.env.QA_BYPASS_TAB_GUARD='0';
 await execute('penkra tabs list','g-list-hidden');
 await execute(snapshotCommand+' --boxes true','g-geometry-hidden');
 await execute('penkra tabs screenshot --tab-id qa-browser-A --document d2 --filename hidden.png','g-screenshot-hidden');
 await execute('penkra tabs record --tab-id qa-browser-A --document d2 --duration-ms 100 --filename hidden.webm','g-record-hidden');
 await execute('penkra tabs trace --tab-id qa-browser-A --document d2 --duration-ms 100 --filename hidden-trace.json','g-trace-hidden');
 await execute('penkra tabs har --tab-id qa-browser-A --document d2 --duration-ms 300 --filename hidden.har','g-har-hidden');
 await execute('penkra tabs evaluate --tab-id qa-browser-A --document d2 --expression \'document.getElementById("probeClick").click();window.qaClicks\'','g-evaluate-hidden-click');
 await show();
 const alertPromise=page.executeJavaScript('alert("Penkra QA dialog");true');await pause(100);
 await execute(snapshotCommand,'g-open-dialog');
 await execute(actStep({action:'dialog',accept:true}),'g-dialog-accept');await alertPromise;
 await execute(actStep({action:'dialog',accept:true}),'g-no-dialog');
 await execute(actStep({action:'wait',document:'d2',text:'never-present-qa-text',timeoutMs:50}),'g-wait-timeout');
 await execute('penkra tabs close --tab-id qa-browser-A','g-close');
 await execute(snapshotCommand,'g-closed-snapshot');

 caseId='cleanup';observer.dispose?.();host.closeAll();await commandServer.dispose();fixtureServer.closeAllConnections();await new Promise<void>(r=>fixtureServer.close(()=>r()));shell.destroy();app.exit(0);
}
run().catch(error=>{console.error(error);fs.writeFileSync(path.join(qaRoot,'evidence','failure.txt'),error.stack??String(error));app.exit(1)});
