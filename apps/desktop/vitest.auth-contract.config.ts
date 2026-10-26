import { defineConfig } from "vitest/config";

// Transform the real Electron auth dependency so its native import can be
// replaced without loading Electron or accessing this Mac's encrypted store.
export default defineConfig({
  test: {
    include: ["src/accountAuthStorageContract.integration.ts"],
    server: { deps: { inline: [/@better-auth\/electron/] } },
  },
});
