import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-diagnostics-worker-crash-"));
const worker = new Worker(path.join(desktopDir, "dist-electron/diagnosticsWorker.js"), {
  workerData: {
    stateDir,
    appVersion: "0.14.3",
    buildId: "abcdef123456",
    process: "desktop-main",
  },
});
try {
  const credit = await Promise.race([
    new Promise((resolve, reject) => {
      worker.on("message", (message) => {
        if (message.kind === "credits") resolve(message);
      });
      worker.once("error", reject);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("No worker credits")), 5_000)),
  ]);
  assert.match(credit.bootId, /^[a-f0-9]{32}$/u);
  await worker.terminate();
  const dir = path.join(stateDir, "diagnostics");
  assert.equal(fs.existsSync(path.join(dir, `active-${credit.bootId}.json`)), true);
  assert.equal(fs.existsSync(path.join(dir, `closed-${credit.bootId}.json`)), false);
} finally {
  await worker.terminate();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
