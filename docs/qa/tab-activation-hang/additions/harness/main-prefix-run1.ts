import {app,BrowserWindow,ipcMain,session,protocol} from "electron";
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
const backendHttpUrl="http://127.0.0.1:3909";
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
