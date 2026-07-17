// FILE: tsdown.config.ts
// Purpose: Builds Electron main/preload code and controls diagnostic source maps.
// Layer: Desktop build config
// Depends on: tsdown.

import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.SYNARA_DESKTOP_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const penkraUpdateToken = process.env.PENKRA_UPDATE_TOKEN?.trim() ?? "";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: buildSourcemap,
  define: { __PENKRA_UPDATE_TOKEN__: JSON.stringify(penkraUpdateToken) },
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: (id) => id.startsWith("@synara/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  {
    ...shared,
    entry: ["src/penkraHqAuthPreload.ts"],
  },
]);
