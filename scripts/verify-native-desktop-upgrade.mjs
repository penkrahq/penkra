// Exercises real installation mechanisms only on disposable native CI runners.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPackagedDesktopSmokeEnvironment,
  resolvePackagedDesktopSmokeLogPath,
  inspectPackagedDesktopStartupLog,
  terminateProcessesInsideRoot,
  removePackagedDesktopSmokeRoot,
} from "./verify-packaged-desktop-startup.ts";

const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { _electron } = requireWeb("playwright");
const [previousDirectory, candidateDirectory, previousVersion, candidateVersion] =
  process.argv.slice(2);
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Installer transactions require a disposable GitHub runner.",
);
assert.ok(["linux", "win32"].includes(process.platform), "Native Linux or Windows required.");
for (const version of [previousVersion, candidateVersion])
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
assert.notEqual(previousVersion, candidateVersion);
assert.ok(previousDirectory && candidateDirectory);
const platform = process.platform === "win32" ? "win" : "linux";
const suffix = platform === "win" ? ".exe" : ".AppImage";
function asset(directory) {
  const matches = readdirSync(directory).filter((name) => name.endsWith(suffix));
  assert.equal(matches.length, 1, `Expected exactly one ${suffix} in ${directory}`);
  return resolve(directory, matches[0]);
}
const previous = asset(previousDirectory);
const candidate = asset(candidateDirectory);
const scratch = resolve(".penkra/scratch");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "native-upgrade-"));
const stateRoot = join(root, "state");
const env = createPackagedDesktopSmokeEnvironment(stateRoot, {
  platform,
  version: previousVersion,
});
const sentinel = join(stateRoot, "user-data", "upgrade-qa-marker.txt");
writeFileSync(sentinel, "preserve-native-upgrade-state");
const evidence = { platform, previousVersion, candidateVersion, stages: [] };
let application;
let server;
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${basename(command)} failed: ${result.stderr}`);
}
async function until(check, description, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${description}`);
}
async function launch(executablePath, version, launchEnv = env) {
  const logPath = resolvePackagedDesktopSmokeLogPath(stateRoot);
  const logOffset = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;
  application = await _electron.launch({
    executablePath,
    args: platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [],
    env: launchEnv,
    timeout: 90_000,
  });
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version);
  const page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopBridge), null, { timeout: 60_000 });
  await until(() => {
    if (!existsSync(logPath)) return false;
    const result = inspectPackagedDesktopStartupLog(readFileSync(logPath, "utf8").slice(logOffset));
    if (result.failure) throw new Error(result.failure);
    return result.hasProof;
  }, `backend and required Apps readiness for ${version}`);
  evidence.stages.push({ stage: "launched", version });
  return page;
}
try {
  if (platform === "win") {
    const installed = join(root, "installed");
    // /D must be last: NSIS treats the rest of the command line as the destination.
    run(previous, ["/S", "/currentuser", `/D=${installed}`]);
    const executable = join(installed, "Penkra.exe");
    assert.ok(existsSync(executable), "NSIS did not install Penkra.exe");
    await launch(executable, previousVersion);
    await application.close();
    application = undefined;
    await terminateProcessesInsideRoot(root);
    run(candidate, ["/S", "/currentuser", `/D=${installed}`]);
    await launch(executable, candidateVersion);
    evidence.stages.push({ stage: "nsis-install-and-upgrade", installed: true });
  } else {
    const installed = join(root, "Penkra.AppImage");
    copyFileSync(previous, installed);
    chmodSync(installed, 0o755);
    run(installed, ["--appimage-extract"]);
    const appDir = join(root, "squashfs-root");
    const executable = join(appDir, "AppRun");
    // Launch the installed image's extracted payload with its real AppImage identity.
    // The production updater replaces this exact image, not the extracted directory.
    const updateEnv = {
      ...env,
      APPIMAGE: installed,
      APPDIR: appDir,
      APPIMAGE_EXTRACT_AND_RUN: "1",
    };
    delete updateEnv.PENKRA_DISABLE_AUTO_UPDATE;
    const allowed = new Set(
      readdirSync(candidateDirectory).filter((name) =>
        statSync(join(candidateDirectory, name)).isFile(),
      ),
    );
    server = createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1));
      if (!allowed.has(name) || basename(name) !== name) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Length": statSync(join(candidateDirectory, name)).size });
      createReadStream(join(candidateDirectory, name)).pipe(response);
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const feed = `http://127.0.0.1:${server.address().port}`;
    const page = await launch(executable, previousVersion, updateEnv);
    await application.evaluate(async ({ app }, url) => {
      const { createRequire } = await import("node:module");
      const requireApp = createRequire(`${app.getAppPath()}/package.json`);
      requireApp("electron-updater").autoUpdater.setFeedURL({
        provider: "generic",
        url,
        useMultipleRangeRequest: false,
      });
    }, feed);
    await page.evaluate(() => window.desktopBridge.checkForUpdates());
    // Penkra normally starts preparation as soon as an update is discovered.
    // Join that real lifecycle rather than treating an already-running download as failure.
    await until(
      async () => {
        const state = await page.evaluate(() => window.desktopBridge.getUpdateState());
        if (state.status === "error") throw new Error(JSON.stringify(state));
        if (state.status === "available")
          await page.evaluate(() => window.desktopBridge.downloadUpdate());
        return state.downloadedVersion === candidateVersion;
      },
      "candidate download and artifact verification",
      180_000,
    );
    const beforeLog = readFileSync(resolvePackagedDesktopSmokeLogPath(stateRoot), "utf8").length;
    const install = await page
      .evaluate(() => window.desktopBridge.installUpdate())
      .catch((error) => ({ transportClosed: String(error) }));
    if (!install.transportClosed) assert.equal(install.accepted, true, JSON.stringify(install));
    const expected = sha(candidate);
    await until(
      () => existsSync(installed) && sha(installed) === expected,
      "production updater installs exact candidate bytes",
    );
    await until(() => {
      const log = readFileSync(resolvePackagedDesktopSmokeLogPath(stateRoot), "utf8").slice(
        beforeLog,
      );
      const result = inspectPackagedDesktopStartupLog(log);
      if (result.failure) throw new Error(result.failure);
      return result.hasProof;
    }, "updated application restarts and boots its backend");
    evidence.stages.push({ stage: "appimage-download-install-restart", sha256: expected });
  }
  assert.equal(readFileSync(sentinel, "utf8"), "preserve-native-upgrade-state");
  evidence.stages.push({ stage: "state-preserved" });
  writeFileSync(
    join(candidateDirectory, `native-upgrade-${platform}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  const logPath = resolvePackagedDesktopSmokeLogPath(stateRoot);
  if (existsSync(logPath)) console.error(readFileSync(logPath, "utf8").slice(-24_000));
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await terminateProcessesInsideRoot(root);
  removePackagedDesktopSmokeRoot(root);
}
