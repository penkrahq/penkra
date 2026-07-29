const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "tmp", "pencil-recovery-components");

const targets = [
  ["welcome", "Sign In Button", "Button / Primary"],
  ["welcome", "Skip Button", "Button / Secondary"],
  ["agents", "Back Button", "Button / Back"],
  ["agents", "Claude", "Agent Card / Claude"],
  ["agents", "Codex", "Agent Card / Codex"],
  ["connections", "Connection — sarah", "Connection Row / Account"],
  ["connections", "Connection — api key", "Connection Row / API Key"],
  ["connections", "Sign in with Claude Button", "Button / Sign in with Claude"],
  ["api-key", "Input", "Input / API Key"],
  ["api-key", "Key Name Field", "Input / Key Name"],
  ["api-key", "Save Button", "Button / Save"],
  ["api-key", "Security Note", "Notice / Security"],
  ["apps", "Search Field", "Input / Search Apps"],
  ["apps", "App — Browser", "App Card / Enabled"],
  ["apps", "App — Microsoft Word", "App Card / Disabled"],
  ["workspace", "Nav Item — Search", "Navigation Row / Default"],
  ["workspace", "Thread — Main", "Thread Row / Selected"],
  ["workspace", "User Row", "Message / User"],
  ["workspace", "Assistant Row", "Message / Assistant"],
  ["workspace", "Composer", "Composer / Default"],
  ["workspace", "Account", "Account Row / Default"],
  ["apps-panel", "Right Panel", "Panel / Apps"],
  ["permission-sheet", "Permission Sheet — Ledger install", "Permission Sheet"],
  ["harness-menu", "Harness Menu", "Menu / Harness"],
  ["model-submenu", "Model Submenu", "Menu / Model"],
  ["quick-settings", "Quick Settings Popover", "Popover / Quick Settings"],
  ["account-menu", "Account Popup Menu", "Menu / Account"],
  ["settings", "Settings Modal", "Modal / Settings"],
  ["settings-permissions", "Permissions Row", "Settings Nav Row / Selected"],
  ["settings-permissions", "General Row", "Settings Nav Row / Default"],
  ["settings-permissions", "Settings Modal", "Modal / Settings / Permissions"],
  ["settings-agents", "Settings Modal", "Modal / Settings / Agents"],
  ["settings-apps", "Settings Modal", "Modal / Settings / Apps"],
  ["settings-connectors", "Settings Modal", "Modal / Settings / Connectors"],
  ["settings-appearance", "Settings Modal", "Modal / Settings / Appearance"],
  ["settings-account", "Settings Modal", "Modal / Settings / Account"],
  ["welcome", "Onboarding Panel", "Onboarding / Welcome"],
  ["agents", "Onboarding Panel", "Onboarding / Connect Agent"],
  ["connections", "Onboarding Panel", "Onboarding / Connections"],
  ["api-key", "Onboarding Panel", "Onboarding / API Key"],
  ["apps", "Onboarding Panel", "Onboarding / Apps"],
  ["workspace", "Sidebar", "Sidebar / Workspace"],
  ["workspace", "Top Bar", "Top Bar / Thread"],
  ["workspace", "Thread", "Thread Shell"],
  ["apps", "Switch", "Switch / On", 0],
  ["apps", "Switch", "Switch / Off", 1],
  ["settings", "Harness Pill", "Harness Pill / Default"],
  ["apps-panel", "Harness Pill — hover", "Harness Pill / Hover"],
  ["apps-panel", "Hover Tooltip", "Tooltip / Hover"],
  ["apps-panel", "Tooltip — Copy response — global", "Tooltip / Copy Response"],
  ["welcome", "Divider", "Divider / Onboarding"],
  ["welcome", "Agent Logos Row", "Agent Logos"],
  ["agents", "Agent Row 1", "Agent Grid Row"],
  ["agents", "Action Group", "Onboarding Actions / Agents"],
  ["connections", "Connections List", "Connections List"],
  ["connections", "Method List", "Connection Method List"],
  ["api-key", "Field Group", "Field Group / API Key"],
  ["apps", "App Grid Scroll", "App Grid"],
  ["apps", "Action Group", "Onboarding Actions / Apps"],
  ["workspace", "Top Nav", "Sidebar Top Navigation"],
  ["workspace", "Workspace — penkra", "Workspace Row"],
  ["workspace", "Folder — penut", "Folder Row"],
  ["workspace", "Thread — Hi", "Thread Row / Default"],
  ["workspace", "Branch Icon", "Branch Icon"],
  ["workspace", "Message Actions", "Message Actions"],
  ["workspace", "Composer Acts", "Composer Actions"],
  ["workspace", "Full Access", "Access Pill / Full Access"],
  ["workspace", "Send Button", "Button / Send"],
  ["settings", "Panel Tabs", "Panel Tabs"],
  ["apps-panel", "GitHub", "App List Row / GitHub"],
  ["permission-sheet", "Required Section", "Permission Section / Required"],
  ["permission-sheet", "Optional Section", "Permission Section / Optional"],
  ["permission-sheet", "Toggle", "Permission Toggle / On"],
  ["settings", "General Row", "Settings Nav Row / General Selected"],
  ["settings", "Account Row", "Settings Nav Row / Account"],
  ["workspace", "Projects", "Sidebar Projects"],
  ["workspace", "Avatar", "Avatar / Account"],
  ["workspace", "Panel Icon", "Button / Panel"],
];

async function extract(win, file, layerName, componentName, occurrence = 0) {
  await win.loadFile(path.join(root, "public", "pencil", `${file}.html`));
  await win.webContents.executeJavaScript("document.fonts.ready");
  const result = await win.webContents.executeJavaScript(`(() => {
    try {
    const wanted = ${JSON.stringify(layerName)};
    const componentName = ${JSON.stringify(componentName)};
    const occurrence = ${JSON.stringify(occurrence)};
    const nodes = [...document.querySelectorAll("[data-pencil-name]")];
    const target = nodes.filter((n) => n.getAttribute("data-pencil-name") === wanted)[occurrence];
    if (!target) throw new Error("Missing layer: " + wanted);

    const color = (value) => {
      if (!value || value === "transparent") return null;
      if (value[0] === "#") return value;
      const m = value.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(",").map((v) => v.trim());
      const hex = (n) => Math.round(Number(n)).toString(16).padStart(2, "0").toUpperCase();
      const alpha = p.length === 4 ? hex(Number(p[3]) * 255) : "";
      return "#" + hex(p[0]) + hex(p[1]) + hex(p[2]) + alpha;
    };
    const px = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    };
    const cleanName = (el) => el.getAttribute("data-pencil-name") || el.tagName.toLowerCase();
    const convert = (el, parentRect) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
      const x = Math.round((rect.left - parentRect.left) * 100) / 100;
      const y = Math.round((rect.top - parentRect.top) * 100) / 100;
      const base = { name: cleanName(el), x, y, width: px(rect.width), height: px(rect.height) };
      const tag = el.tagName.toUpperCase();
      if (tag === "IMG") {
        const src = el.getAttribute("src") || "";
        return {...base, type:"rectangle", fill:{type:"image",url:"./recovery/"+src.split("/").pop(),mode:"fill"}};
      }
      if (tag === "SVG") {
        const vb = (el.getAttribute("viewBox") || ("0 0 " + rect.width + " " + rect.height)).split(/\\s+/).map(Number);
        const children = [...el.querySelectorAll("path")].map((p) => {
          const pcs = getComputedStyle(p);
          const fill = color(p.getAttribute("fill") || pcs.fill) || "#00000000";
          const stroke = color(p.getAttribute("stroke") || pcs.stroke);
          const node = {type:"path",name:cleanName(p),x:0,y:0,width:px(rect.width),height:px(rect.height),
            geometry:p.getAttribute("d") || "",viewBox:vb,fill,opacity:Number(pcs.opacity || 1)};
          if (stroke) {
            node.stroke = stroke;
            node.strokeWidth = px(p.getAttribute("stroke-width") || pcs.strokeWidth) || 1;
            node.strokeLinecap = p.getAttribute("stroke-linecap") || "round";
            node.strokeLinejoin = p.getAttribute("stroke-linejoin") || "round";
          }
          return node;
        });
        return {...base,type:"frame",layout:"none",fill:"#00000000",children};
      }
      const elementChildren = [...el.children];
      const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (!elementChildren.length && text) {
        const lh = px(cs.lineHeight);
        const fs = px(cs.fontSize) || 14;
        const nowrap = cs.whiteSpace === "nowrap";
        const textNode = {name:base.name,x:base.x,y:base.y,type:"text",content:text,textGrowth:nowrap ? "auto" : "fixed-width",
          fontFamily:"Inter",fontSize:fs,fontWeight:String(cs.fontWeight || "400"),
          lineHeight:lh ? Math.round((lh/fs)*1000)/1000 : undefined,
          letterSpacing:px(cs.letterSpacing),textAlign:cs.textAlign || "left",
          fill:color(cs.color) || "#E8EAF2",opacity:Number(cs.opacity || 1)};
        if (!nowrap) textNode.width = px(rect.width) + 2;
        return textNode;
      }
      const bg = color(cs.backgroundColor);
      const bw = px(cs.borderTopWidth);
      const border = color(cs.borderTopColor);
      const bgImageMatch = cs.backgroundImage && cs.backgroundImage.match(/^url\\([\"']?(.*?)[\"']?\\)$/);
      const imageFill = bgImageMatch ? {
        type:"image",
        url:"./recovery/" + decodeURIComponent(bgImageMatch[1]).split("/").pop(),
        mode:cs.backgroundSize === "cover" ? "fill" : "fit"
      } : null;
      const node = {...base,type:"frame",layout:"none",clip:["hidden","clip"].includes(cs.overflow),
        fill:imageFill || bg || "#00000000",cornerRadius:px(cs.borderTopLeftRadius),opacity:Number(cs.opacity || 1)};
      if (bw && border) { node.stroke=border; node.strokeWidth=bw; node.strokeAlignment="inner"; }
      node.children = elementChildren.map((child) => convert(child, rect)).filter(Boolean);
      return node;
    };
    const tr = target.getBoundingClientRect();
    let result = convert(target, {left:tr.left,top:tr.top});
    if (result && result.type !== "frame") {
      const child = {...result, x:0, y:0, name:result.name + " Content"};
      result = {type:"frame",name:componentName,x:0,y:0,width:px(tr.width),height:px(tr.height),layout:"none",fill:"#00000000",children:[child]};
    }
    result.x = 0;
    result.y = 0;
    result.name = componentName;
    result.reusable = true;
    result.placeholder = true;
    return result;
    } catch (error) {
      return {__error: String(error && (error.stack || error.message) || error)};
    }
  })()`);
  if (result && result.__error) throw new Error(result.__error);
  return result;
}

function buildBatch(component) {
  const json = JSON.stringify(component);
  return `data=${json}
pos=FindEmptySpace({width:data.width,height:data.height,direction:"top",padding:64})
function add(parent,node,isRoot){
 const children=node.children||[]
 const base={...node}
 delete base.children
 if(isRoot){base.x=pos.x;base.y=pos.y}
 const nodeId=Insert(parent,base)
 for(const child of children)add(nodeId,child,false)
 return nodeId
}
root=add(document,data,true)
Update(root,{placeholder:false})`;
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith(".js") || file === "manifest.json") fs.rmSync(path.join(outDir, file));
  }
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { offscreen: true } });
  const manifest = [];
  for (let i = 0; i < targets.length; i++) {
    const [file, layer, name, occurrence] = targets[i];
    const component = await extract(win, file, layer, name, occurrence);
    const batchFile = path.join(outDir, `${String(i + 1).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.js`);
    fs.writeFileSync(batchFile, buildBatch(component));
    manifest.push({ file, layer, name, batchFile, width: component.width, height: component.height });
    process.stdout.write(`Extracted ${name} (${component.width}×${component.height})\\n`);
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
