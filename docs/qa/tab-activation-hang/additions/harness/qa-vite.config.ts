import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
const src=path.resolve(import.meta.dirname,"src"); const stub=path.resolve(import.meta.dirname,"../../qa/fixture-stubs.tsx");
const mocks=["/threadListStore","/composerDraftStore","/store","/storeSelectors","/appInstallationStore","/nativeApi","/components/ui/toast","/lib/threadResourceOpener","/components/ChatView","/components/RouteInsetSurface"];
export default defineConfig({plugins:[{name:"qa-fixtures",enforce:"pre",resolveId(id,importer){if(!importer||id.endsWith("fixture-stubs.tsx"))return;let absolute=id.startsWith("~/")?path.join(src,id.slice(2)):id.startsWith(".")?path.resolve(path.dirname(importer),id):id;absolute=absolute.replace(/\.(tsx?|jsx?)$/," ").trim();if(mocks.some(s=>absolute===src+s))return stub;}},react(),tailwindcss()],resolve:{alias:[{find:"~",replacement:src},{find:/^@penkra\/contracts$/,replacement:path.resolve(import.meta.dirname,"../../packages/contracts/src/index.ts")},{find:/^@penkra\/shared\//,replacement:path.resolve(import.meta.dirname,"../../packages/shared/src")+"/"}]},server:{host:"127.0.0.1",port:5909,strictPort:true,fs:{allow:[path.resolve(import.meta.dirname,"../.."),path.resolve(import.meta.dirname,"node_modules")]}}});
