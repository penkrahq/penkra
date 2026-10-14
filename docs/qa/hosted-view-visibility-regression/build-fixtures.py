from pathlib import Path
import re,json,hashlib
r=Path(__file__).resolve().parent
for label in ['fix','parent','changed','head']:
 s=r/label/'source';q=s/'qa';(q/'node_modules').symlink_to(s/'apps/web/node_modules',target_is_directory=True)
 side=(s/'apps/web/src/components/ui/sidebar.tsx').read_text();a=side.index('export function appDockBoundsForWidth(');b=side.index('\n}',a)+2;fn=side[a:b]
 # Preserve the exact bounds function; its two module constants come from that revision.
 (q/'sidebar-bounds.ts').write_text('import {CHAT_SURFACE_HEADER_HEIGHT_PX} from "@penkra/shared/desktopChrome";\nconst NATIVE_APP_SPLITTER_CLEARANCE_PX=1;\n'+fn+'\n')
 (q/'renderer.tsx').write_text('''import React from "react";import {createRoot} from "react-dom/client";import {AppDockPane} from "../apps/web/src/components/chat/AppDockPane";
const seed=await window.desktopBridge.qa.seed();createRoot(document.getElementById('root')!).render(<div data-slot="sidebar-wrapper" style={{position:'absolute',right:0,top:0,width:400,height:'100%'}}><AppDockPane {...seed} /></div>);setTimeout(()=>window.desktopBridge.qa.ready(),500);
''')
 (q/'preload.cjs').write_text('''const {contextBridge,ipcRenderer}=require('electron');const listen=(channel,cb)=>{const f=(_e,v)=>cb(v);ipcRenderer.on(channel,f);return()=>ipcRenderer.removeListener(channel,f)};contextBridge.exposeInMainWorld('desktopBridge',{qa:{seed:()=>ipcRenderer.invoke('qa-seed'),ready:()=>ipcRenderer.send('qa-ready')},appTabs:{present:v=>ipcRenderer.invoke('qa-present',v),hide:v=>ipcRenderer.invoke('qa-hide',v),trace:v=>ipcRenderer.send('qa-trace',v),onPresentation:cb=>listen('qa-presentation',cb)}});
''')
 (q/'build.mjs').write_text('''import path from 'node:path';
const root=process.cwd();const plugin={name:'qa-alias',setup(build){build.onResolve({filter:/^@penkra\\/contracts$/},()=>({path:path.join(root,'packages/contracts/src/index.ts')}));build.onResolve({filter:/^@penkra\\/shared\\//},args=>({path:path.join(root,'packages/shared/src',args.path.slice('@penkra/shared/'.length)+'.ts')}));build.onResolve({filter:/^~\\//},args=>({path:path.join(root,'apps/web/src',args.path.slice(2))+(/\\.[a-z]+$/.test(args.path)?'':'.ts')}));build.onResolve({filter:/^\.\.\\/ui\\/sidebar$/},()=>({path:path.join(root,'qa/sidebar-bounds.ts')}));}};
for(const [entry,target] of [['qa/main.ts','node'],['qa/renderer.tsx','browser']]){const result=await Bun.build({entrypoints:[entry],outdir:'qa/bundle',target,format:target==='node'?'cjs':'esm',external:target==='node'?['electron']:[],plugins:[plugin]});if(!result.success){for(const l of result.logs)console.error(l);process.exit(1)}if(target==='node')await Bun.write('qa/bundle/main.cjs',await result.outputs[0].text());}await Bun.write('qa/bundle/package.json',JSON.stringify({name:'qa-visibility-history',main:'main.cjs'}));
''')
