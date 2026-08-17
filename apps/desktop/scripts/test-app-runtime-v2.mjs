import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceArgument = process.argv[2];
if (!sourceArgument) throw new Error("Usage: node scripts/test-app-runtime-v2.mjs <app-directory>");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const electron = createRequire(import.meta.url)("electron");
const host = resolve(desktopDirectory, "dist-electron/entry.js");
const sourceRoot = await realpath(resolve(sourceArgument));
const stageSource = process.argv.includes("--exclude-node-modules");
const staged = stageSource
  ? await mkdtemp(resolve(tmpdir(), "penkra-runtime-v2-app-source-"))
  : null;
const source = staged ? resolve(staged, "app") : sourceRoot;
if (staged) {
  await cp(sourceRoot, source, {
    recursive: true,
    filter: (candidate) => !candidate.split(/[\\/]/).includes("node_modules"),
  });
}
const profile = await mkdtemp(resolve(tmpdir(), "penkra-runtime-v2-app-test-"));
const resultPath = resolve(profile, "result.json");
const environment = {
  ...process.env,
  PENKRA_INTERNAL_DESKTOP_MODE: "app-test",
  PENKRA_APP_TEST_SOURCE: source,
  PENKRA_APP_TEST_PROFILE: profile,
  PENKRA_APP_TEST_RESULT: resultPath,
};
delete environment.ELECTRON_RUN_AS_NODE;

try {
  const output = await run(electron, host, environment);
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  if (result.ok !== true || result.tab?.status !== "ready") {
    throw new Error(`${result.error ?? "Runtime v2 App test failed."}\n${output}`.trim());
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(profile, { recursive: true, force: true });
  if (staged) await rm(staged, { recursive: true, force: true });
}

function run(executable, hostPath, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, [hostPath], {
      cwd: desktopDirectory,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`Runtime v2 App test timed out.\n${output}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun(output);
      else rejectRun(new Error(`Runtime v2 App test exited ${signal ?? code}.\n${output}`));
    });
  });
}
