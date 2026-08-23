// FILE: tsdown.config.ts
// Purpose: Builds the Penkra server CLI and controls diagnostic source maps.
// Layer: Server build config
// Depends on: tsdown.

import { defineConfig } from "tsdown";
import { readFile } from "node:fs/promises";

const sourcemapEnv = process.env.PENKRA_SERVER_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";

export default defineConfig({
  entry: ["src/index.ts", "src/databaseMaintenance.ts", "src/restoreMigrationBackup.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: buildSourcemap,
  clean: true,
  noExternal: (id) => id.startsWith("@penkra/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
  plugins: [
    {
      name: "penkra-markdown-text",
      async load(id) {
        if (!id.endsWith(".md?raw")) return null;
        return {
          code: `export default ${JSON.stringify(await readFile(id.slice(0, -4), "utf8"))};`,
        };
      },
    },
  ],
});
