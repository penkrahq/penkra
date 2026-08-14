// FILE: dev.mjs
// Purpose: Runs the desktop/server bundle watchers and Electron watcher together in dev.
// Layer: Desktop dev script
// Depends on: desktop scripts `dev:bundle` and `dev:electron`, plus server `dev:bundle`

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bunExecutable = process.execPath;
const serverDirectory = fileURLToPath(new URL("../../server/", import.meta.url));
const childProcesses = [];
let isShuttingDown = false;

// Start one named Bun script and stream its output into the current terminal.
function startScript(scriptName, cwd) {
  const child = spawn(bunExecutable, ["run", scriptName], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  childProcesses.push(child);
  return child;
}

function stopAll(signal = "SIGTERM") {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  for (const child of childProcesses) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }
    child.kill(signal);
  }
}

function wireExit(child, scriptName) {
  child.once("exit", (code, signal) => {
    if (isShuttingDown) {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
      return;
    }

    stopAll(signal ?? "SIGTERM");
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.once("error", (error) => {
    console.error(`[desktop-dev] Failed to start ${scriptName}`, error);
    stopAll();
    process.exit(1);
  });
}

const bundleWatcher = startScript("dev:bundle");
const serverBundleWatcher = startScript("dev:bundle", serverDirectory);
const electronWatcher = startScript("dev:electron");

wireExit(bundleWatcher, "dev:bundle");
wireExit(serverBundleWatcher, "server dev:bundle");
wireExit(electronWatcher, "dev:electron");

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    stopAll(signal);
  });
}
