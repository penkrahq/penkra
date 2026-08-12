import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const electronBin = require("electron");
const mainJs = resolve(desktopDir, "dist-electron/entry.js");
const preloadFiles = ["preload.js", "appPreload.js", "simulatorViewerPreload.js"];

for (const preloadFile of preloadFiles) {
  const preloadPath = resolve(desktopDir, "dist-electron", preloadFile);
  if (!existsSync(preloadPath)) {
    throw new Error(`Desktop preload output is missing: ${preloadFile}`);
  }
  const source = readFileSync(preloadPath, "utf8");
  const relativeModuleLoad =
    /\brequire\(\s*["']\.\.?\//.test(source) || /\bimport\(\s*["']\.\.?\//.test(source);
  if (relativeModuleLoad) {
    throw new Error(
      `Desktop preload output must be self-contained for Electron sandboxing: ${preloadFile}`,
    );
  }
}

const smokeRoot = mkdtempSync(resolve(tmpdir(), "penkra-desktop-smoke-"));
mkdirSync(resolve(smokeRoot, "workspace"));
const smokeEnvironment = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: "1",
  PENKRA_DESKTOP_FLAVOR: "development",
  PENKRA_HOME: resolve(smokeRoot, "home"),
  PENKRA_SKIP_LOGIN_SHELL_ENVIRONMENT: "1",
  PENKRA_DESKTOP_SMOKE_USER_DATA: resolve(smokeRoot, "user-data"),
  PENKRA_ROOT: resolve(smokeRoot, "workspace"),
};
delete smokeEnvironment.VITE_DEV_SERVER_URL;

console.log("\nLaunching Electron smoke test...");

const child = spawn(electronBin, [mainJs], {
  stdio: ["pipe", "pipe", "pipe"],
  env: smokeEnvironment,
});

let output = "";
let rendererCapabilities = null;
let smokeFailure = null;
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  readRendererCapabilities();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  readRendererCapabilities();
});

const timeout = setTimeout(() => {
  smokeFailure = "Timed out waiting for the production renderer capability check.";
  child.kill(process.platform === "win32" ? undefined : "SIGKILL");
}, 8_000);

child.on("exit", () => {
  clearTimeout(timeout);
  if (smokeFailure) {
    for (const logName of ["desktop-main.log", "server-child.log"]) {
      const logPath = resolve(smokeRoot, "home", "userdata", "logs", logName);
      if (existsSync(logPath)) {
        output += `\n[${logName}]\n${readFileSync(logPath, "utf8")}`;
      }
    }
  }
  rmSync(smokeRoot, { recursive: true, force: true });

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "App threw an error during load",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));
  if (smokeFailure) failures.push(smokeFailure);
  if (!rendererCapabilities && !smokeFailure) {
    failures.push("Electron exited before the renderer capability check completed.");
  }

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
});

function stopChild() {
  child.kill(process.platform === "win32" ? undefined : "SIGKILL");
}

function readRendererCapabilities() {
  if (rendererCapabilities) return;
  const match = output.match(/\[desktop-smoke\] renderer-capabilities (\{[^\n]+\})/);
  if (!match) return;
  try {
    rendererCapabilities = JSON.parse(match[1]);
  } catch {
    smokeFailure = "Could not parse the renderer capability check.";
    clearTimeout(timeout);
    stopChild();
    return;
  }
  if (
    !rendererCapabilities.isSecureContext ||
    !rendererCapabilities.hasMediaDevices ||
    !rendererCapabilities.hasGetUserMedia
  ) {
    smokeFailure = `Renderer lacks secure microphone APIs: ${JSON.stringify(rendererCapabilities)}`;
  }
  clearTimeout(timeout);
  stopChild();
}
