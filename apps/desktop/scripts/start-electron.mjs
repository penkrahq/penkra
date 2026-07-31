import { spawn } from "node:child_process";

import { buildAppSnapHelper } from "./build-appsnap-helper.mjs";
import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

if (process.platform === "darwin") {
  buildAppSnapHelper({ arch: process.arch });
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(resolveElectronPath(), ["dist-electron/main.js"], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

let forwardedSignal = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (forwardedSignal !== null) return;
    forwardedSignal = signal;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      return;
    }
    process.exit(0);
  });
}

child.on("exit", (code, signal) => {
  if (signal && forwardedSignal === null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
