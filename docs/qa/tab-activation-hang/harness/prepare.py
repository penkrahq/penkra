from pathlib import Path
import json,hashlib
src=Path(__file__).resolve().parents[1];q=src/'qa'; main=(src/'apps/desktop/src/main.ts').read_text()
fragments={
 'routing-activation':main[main.index('function routeAppTab('):main.index('function inheritThreadHome(')],
 'diagnostics':main[main.index('function traceAppTab(event:'):main.index('function resizeAppTabWindow(')],
 'claim-fail-ipc':main[main.index('  ipcMain.handle(IPC.appTabs.claimActivation,'):main.index('  ipcMain.handle(IPC.appTabs.consumeListingRequest,')],
 'present-hide-ipc':main[main.index('  ipcMain.handle(IPC.appTabs.present,'):main.index('  ipcMain.on(IPC.appTabs.overlayActive,')],
 'window-events':main[main.index('  window.on("hide", () => {'):main.index('  window.on("maximize", () => {')],
}
(q/'source-fragments.json').write_text(json.dumps({key:{'sha256':hashlib.sha256(value.encode()).hexdigest(),'source':value} for key,value in fragments.items()},indent=2))
for key,value in fragments.items(): (q/(key+'.txt')).write_text(value)
(q/'fixture-stubs.tsx').write_text('''import React from "react";
export default function ChatView(){return <div>QA agent thread · folder qa-folder</div>}
export const useThreadSummary=()=>({spaceId:"qa-space"});
export const useComposerDraftStore=(f:any)=>f({draftThreadsByThreadId:{}});
export const useStore=(f:any)=>f({});
export const createProjectSelector=()=>()=>({spaceId:"qa-space",cwd:"/qa/fixture"});
export const useAppInstallationSnapshot=()=>null;
export const ensureNativeApi=()=>({cleanCore:{getFolderAppTabs:async()=>window.qaFolderTabs}});
export const createNativeApi=ensureNativeApi;
export const useThreadToastViewportHostRef=()=>React.useRef(null);
export const toastManager={add:(value:any)=>console.info("QA toast",value)};
export const RouteInsetSurface=({children}:any)=><div style={{height:"100%"}}>{children}</div>;
export const ThreadResourceOpenerContext=React.createContext({});
export const createThreadResourceOpener=()=>({});
export const showThreadResourceContextMenu=()=>false;
export const openThreadFileReference=()=>{};
export const useThreadResourceOpener=()=>({});
''')
(src/'apps/web/qa-vite.config.ts').write_text('''import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
const src=path.resolve(import.meta.dirname,"src"); const stub=path.resolve(import.meta.dirname,"../../qa/fixture-stubs.tsx");
const mocks=["/threadListStore","/composerDraftStore","/store","/storeSelectors","/appInstallationStore","/nativeApi","/components/ui/toast","/lib/threadResourceOpener","/components/ChatView","/components/RouteInsetSurface"];
export default defineConfig({plugins:[{name:"qa-fixtures",enforce:"pre",resolveId(id,importer){if(!importer||id.endsWith("fixture-stubs.tsx"))return;let absolute=id.startsWith("~/")?path.join(src,id.slice(2)):id.startsWith(".")?path.resolve(path.dirname(importer),id):id;absolute=absolute.replace(/\\.(tsx?|jsx?)$/," ").trim();if(mocks.some(s=>absolute===src+s))return stub;}},react(),tailwindcss()],resolve:{alias:[{find:"~",replacement:src},{find:/^@penkra\\/contracts$/,replacement:path.resolve(import.meta.dirname,"../../packages/contracts/src/index.ts")},{find:/^@penkra\\/shared\\//,replacement:path.resolve(import.meta.dirname,"../../packages/shared/src")+"/"}]},server:{host:"127.0.0.1",port:5909,strictPort:true,fs:{allow:[path.resolve(import.meta.dirname,"../.."),path.resolve(import.meta.dirname,"node_modules")]}}});
''')
(src/'apps/web/qa.html').write_text('<html><body><div id="root"></div><script type="module" src="/../../qa/renderer.tsx"></script></body></html>')
# Vite imports served from workspace's /@fs namespace.
(src/'apps/web/qa.html').write_text('<html><body><div id="root"></div><script type="module" src="/@fs/'+str(q/'renderer.tsx')+'"></script></body></html>')
(q/'renderer.tsx').write_text('''import React from "react";
import {createRoot} from "react-dom/client";
import "../apps/web/src/index.css";
import {SingleChatSurface} from "../apps/web/src/components/chat/SingleChatSurface";
import {SidebarProvider} from "../apps/web/src/components/ui/sidebar";
import {applyFolderAppTabs,useRightDockStore} from "../apps/web/src/rightDockStore";
const seed=await window.desktopBridge.qa.getSeed();
window.qaFolderTabs=seed.folderTabs;
window.qa={setup:async(active:string,open:boolean)=>{useRightDockStore.getState().setActivePane("qa-folder",active);useRightDockStore.getState().setDockOpen("qa-folder",open);await new Promise(r=>setTimeout(r,350));return window.qa.state();},state:()=>JSON.parse(JSON.stringify(useRightDockStore.getState().dockStateByFolderId["qa-folder"]))};
applyFolderAppTabs(seed.folderTabs);
createRoot(document.getElementById("root")!).render(<SidebarProvider><div style={{width:"100vw",height:"100vh"}}><SingleChatSurface threadId={"qa-agent-thread" as any} folderId={"qa-folder" as any}/></div></SidebarProvider>);
window.desktopBridge.qa.ready();
''')
(q/'preload.cjs').write_text('''const {contextBridge,ipcRenderer}=require("electron");
const ch=prefix=>"desktop:app-tabs-"+prefix;
const listen=(channel,callback)=>{const handler=(_e,value)=>callback(value);ipcRenderer.on(channel,handler);return()=>ipcRenderer.removeListener(channel,handler)};
contextBridge.exposeInMainWorld("desktopBridge",{
 appTabs:{claimActivation:id=>ipcRenderer.invoke(ch("claim-activation"),id),failActivation:(id,message)=>ipcRenderer.invoke(ch("fail-activation"),id,message),present:input=>ipcRenderer.invoke(ch("present"),input),hide:input=>ipcRenderer.invoke(ch("hide"),input),trace:input=>ipcRenderer.send(ch("trace"),input),onActivationRequested:cb=>listen(ch("activation-requested"),cb),onPresentation:cb=>listen(ch("presentation"),cb),onOpened:cb=>listen(ch("opened"),cb),onState:cb=>listen(ch("state"),cb),onClosed:cb=>listen(ch("closed"),cb),list:()=>ipcRenderer.invoke("qa-list"),setContext:()=>Promise.resolve(),consumeListingRequest:()=>Promise.resolve(null),onListingRequested:cb=>listen(ch("listing-requested"),cb)},
 getWindowState:()=>Promise.resolve({maximized:false,fullscreen:false}),onWindowStateChanged:()=>()=>{},setAppDockWidth:()=>{},
 qa:{getSeed:()=>ipcRenderer.invoke("qa-seed"),ready:()=>ipcRenderer.send("qa-ready")}
});
''')
(q/'app-preload.cjs').write_text('')
print('Fixture sources prepared',src)
