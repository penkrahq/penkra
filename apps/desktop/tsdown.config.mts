// FILE: tsdown.config.ts
// Purpose: Builds Electron main/preload code and controls diagnostic source maps.
// Layer: Desktop build config
// Depends on: tsdown.

import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.PENKRA_DESKTOP_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const registryTrustedKeys = process.env.PENKRA_REGISTRY_TRUSTED_KEYS?.trim() ?? "";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: buildSourcemap,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/entry.ts", "src/main.ts", "src/appTestHost.ts"],
    clean: true,
    // Electron exposes this builtin only at runtime; keeping it external avoids
    // asking Rolldown to resolve a package that intentionally does not exist.
    external: ["original-fs"],
    define: {
      __PENKRA_REGISTRY_TRUSTED_KEYS__: JSON.stringify(registryTrustedKeys),
    },
    noExternal: (id) => id.startsWith("@penkra/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
    // Electron sandboxed preloads cannot require build-time sibling chunks.
    // Keep every preload self-contained even when more shared imports are added.
    outputOptions: { codeSplitting: false },
  },
  {
    ...shared,
    entry: ["src/appPreload.ts"],
    outputOptions: { codeSplitting: false },
    noExternal: (id) => id.startsWith("@penkra/"),
  },
  {
    ...shared,
    entry: ["src/simulatorViewerPreload.ts"],
    outputOptions: { codeSplitting: false },
  },
  {
    ...shared,
    entry: ["src/simulatorLicenseReviewPreload.ts"],
    outputOptions: { codeSplitting: false },
  },
]);
