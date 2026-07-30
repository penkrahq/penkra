import { spawn } from "node:child_process";

import { buildAppSnapHelper } from "./build-appsnap-helper.mjs";
import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

if (process.platform === "darwin") {
  buildAppSnapHelper({ arch: process.arch });
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const canaryRootArgument = process.argv.find((argument) =>
  argument.startsWith("--penkra-canary-root="),
);
const child = spawn(
  resolveElectronPath(),
  ["dist-electron/main.js", ...(canaryRootArgument ? [canaryRootArgument] : [])],
  {
    stdio: "inherit",
    cwd: desktopDir,
    env: childEnv,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
