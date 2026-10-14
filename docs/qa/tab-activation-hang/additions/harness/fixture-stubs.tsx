import React from "react";
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
