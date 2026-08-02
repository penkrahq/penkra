#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function scaffold(argv, cwd = process.cwd()) {
  if (argv.includes("--help") || argv.length === 0) {
    return { help: "Usage: create-penkra-app <directory> [--template vanilla|react]" };
  }
  const directory = argv.find((value) => !value.startsWith("-"));
  const templateIndex = argv.indexOf("--template");
  const template = templateIndex === -1 ? "vanilla" : argv[templateIndex + 1];
  if (!directory) throw new Error("An output directory is required.");
  if (template !== "vanilla" && template !== "react") {
    throw new Error("Template must be vanilla or react.");
  }
  const target = path.resolve(cwd, directory);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`Refusing to overwrite non-empty directory: ${target}`);
  }
  fs.mkdirSync(target, { recursive: true });
  const slug =
    path
      .basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "sample-app";
  const name = slug
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
  const files = template === "react" ? reactFiles(slug, name) : vanillaFiles(slug, name);
  for (const [relative, contents] of Object.entries(commonFiles(slug, name, template, files))) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  return { target, template };
}

function commonFiles(slug, name, template, files) {
  return {
    "package.json": `${JSON.stringify({ name: slug, private: true, type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { "@penkra/sdk": "latest", "@penkra/ui": "latest", ...(template === "react" ? { react: "latest", "react-dom": "latest" } : {}), vite: "latest" } }, null, 2)}\n`,
    "penkra-app.json": `${JSON.stringify({ manifestVersion: 1, id: `com.example.${slug}`, slug, name, summary: `${name} for Penkra.`, version: "0.1.0", compatibility: { penkra: ">=0.8.0" }, icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }], entrypoints: { app: "app.html", operations: "operations.html" }, permissions: [], operations: [{ key: "notes.create", summary: "Create a note.", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, output: { type: "object", properties: { saved: { type: "boolean" } }, required: ["saved"], additionalProperties: false }, handler: "notes.create" }] }, null, 2)}\n`,
    "README.md": `# ${name}\n\nA complete Penkra App scaffold. The App Bar is page-owned and may be omitted on routes that need the full canvas.\n`,
    "INSTRUCTIONS.md": `# ${name} operations\n\nUse \`${slug} notes create --input '{"text":"..."}'\` only when the user asks to save a note.\n`,
    "operations.html": `<script type="module" src="/src/operations.js"></script>\n`,
    "vite.config.js": `import fs from "node:fs"; import path from "node:path"; import { defineConfig } from "vite";\nconst root=import.meta.dirname; export default defineConfig({build:{outDir:"dist",emptyOutDir:true,rollupOptions:{input:{app:path.join(root,"app.html"),operations:path.join(root,"operations.html")}}},plugins:[{name:"penkra-metadata",closeBundle(){for(const file of ["penkra-app.json","README.md","INSTRUCTIONS.md","icon.svg"])fs.copyFileSync(path.join(root,file),path.join(root,"dist",file));}}]});\n`,
    "src/operations.js": `import { operations } from "@penkra/sdk";\noperations.handle("notes.create", async ({ text }) => ({ saved: typeof text === "string" && text.length > 0 }));\n`,
    "icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#6957ff"/><path d="M18 20h28v24H18z" fill="none" stroke="white" stroke-width="4"/></svg>\n`,
    ...files,
  };
}

function vanillaFiles(_slug, name) {
  return {
    "app.html": `<div id="app"></div><script type="module" src="/src/app.js"></script>\n`,
    "src/app.js": `import "@penkra/ui/tokens.css"; import "@penkra/ui/app-bar.css"; import { createAppBar, createIcon } from "@penkra/ui";\nconst root=document.querySelector("#app"); const bar=createAppBar({center:{kind:"display",text:${JSON.stringify(name)},icon:()=>createIcon("search")}}); root.append(bar.element,Object.assign(document.createElement("main"),{textContent:"Your Penkra App is ready."}));\n`,
  };
}

function reactFiles(_slug, name) {
  return {
    "app.html": `<div id="root"></div><script type="module" src="/src/main.jsx"></script>\n`,
    "src/main.jsx": `import React from "react"; import { createRoot } from "react-dom/client"; import "@penkra/ui/tokens.css"; import "@penkra/ui/app-bar.css"; import { AppBar, PenkraIcon } from "@penkra/ui/react";\nfunction App(){return <><AppBar center={{kind:"display",text:${JSON.stringify(name)},icon:<PenkraIcon name="search"/>}}/><main>Your Penkra App is ready.</main></>} createRoot(document.getElementById("root")).render(<App/>);\n`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = scaffold(process.argv.slice(2));
    console.log(result.help ?? `Created ${result.template} Penkra App at ${result.target}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
