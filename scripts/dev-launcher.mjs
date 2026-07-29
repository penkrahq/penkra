import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..');
const stateDirectory = join(homedir(), 'Library', 'Application Support', 'Penkra Dev');
const logDirectory = join(homedir(), 'Library', 'Logs', 'Penkra Dev');
const launcherLog = join(logDirectory, 'launcher.log');
const devLog = join(logDirectory, 'development.log');
const statusFile = join(stateDirectory, 'status.json');
const pidFile = join(stateDirectory, 'development.pid');
const electronPidFile = join(stateDirectory, 'electron.pid');
const rendererReadyFile = join(stateDirectory, 'renderer-ready.json');
const runtimeFailureFile = join(stateDirectory, 'runtime-failure.json');
const healthURL = 'http://127.0.0.1:5173/';

mkdirSync(stateDirectory, { recursive: true });
mkdirSync(logDirectory, { recursive: true });

function record(event, details = {}) {
  appendFileSync(
    launcherLog,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
  );
}

function writeStatus(phase, details = {}) {
  const status = {
    timestamp: new Date().toISOString(),
    phase,
    repoRoot,
    healthURL,
    launcherLog,
    devLog,
    ...details,
  };
  writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);
  record(`status:${phase}`, details);
  return status;
}

function readPid(file = pidFile) {
  if (!existsSync(file)) return undefined;
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy() {
  try {
    const response = await fetch(healthURL, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function readStatus() {
  if (!existsSync(statusFile)) return undefined;
  try {
    return JSON.parse(readFileSync(statusFile, 'utf8'));
  } catch {
    return undefined;
  }
}

async function printStatus() {
  const recorded = readStatus();
  const pid = readPid();
  const electronPid = readPid(electronPidFile);
  const processAlive = isAlive(pid);
  const electronAlive = isAlive(electronPid);
  const rendererLoaded = existsSync(rendererReadyFile);
  const viteHealthy = await isHealthy();
  const verified = processAlive && electronAlive && rendererLoaded && viteHealthy;
  let runtimeFailure = null;
  if (existsSync(runtimeFailureFile)) {
    try {
      runtimeFailure = JSON.parse(readFileSync(runtimeFailureFile, 'utf8'));
    } catch {
      runtimeFailure = { message: 'Runtime failure record could not be parsed.' };
    }
  }
  const result = {
    verified,
    recordedPhase: recorded?.phase ?? 'never-launched',
    developmentPid: pid ?? null,
    electronPid: electronPid ?? null,
    processAlive,
    electronAlive,
    rendererLoaded,
    viteHealthy,
    healthURL,
    statusFile,
    launcherLog,
    devLog,
    lastFailure: runtimeFailure ?? recorded?.failure ?? null,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = verified ? 0 : 1;
}

function launch() {
  const existingPid = readPid();
  if (isAlive(existingPid)) {
    const electronPid = readPid(electronPidFile);
    const details = { developmentPid: existingPid, electronPid: electronPid ?? null };
    if (isAlive(electronPid)) {
      try {
        execFileSync('/usr/bin/osascript', [
          '-e',
          `tell application "System Events" to set frontmost of first process whose unix id is ${electronPid} to true`,
        ]);
        record('launch-request:activated-existing', details);
      } catch (error) {
        record('launch-request:activation-failed', {
          ...details,
          failure: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      record('launch-request:already-starting', details);
    }
    return;
  }

  if (existingPid) rmSync(pidFile, { force: true });
  rmSync(electronPidFile, { force: true });
  rmSync(rendererReadyFile, { force: true });
  rmSync(runtimeFailureFile, { force: true });
  const supervisor = spawn(process.execPath, [fileURLToPath(import.meta.url), 'supervise'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
  });
  supervisor.unref();
  record('launch-request:accepted', { supervisorPid: supervisor.pid });
}

async function supervise() {
  let phase = 'preflight';
  try {
    writeStatus(phase, { supervisorPid: process.pid });

    const requiredFiles = ['package.json', 'electron/main.cjs', 'vite.config.ts'];
    const missingFiles = requiredFiles.filter((file) => !existsSync(join(repoRoot, file)));
    if (missingFiles.length > 0) {
      throw new Error(`Repository is missing required files: ${missingFiles.join(', ')}`);
    }

    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    if (!packageJson.scripts?.dev) {
      throw new Error('package.json does not define the required dev script');
    }
    if (!process.env.npm_execpath || !existsSync(process.env.npm_execpath)) {
      throw new Error('npm CLI path is missing; reinstall Penkra Dev with `npm run dev:install-app`');
    }

    if (await isHealthy()) {
      throw new Error(
        `Port 5173 is already serving HTTP but is not owned by the recorded Penkra Dev process`,
      );
    }

    phase = 'starting-development-process';
    const logFd = openSync(devLog, 'a');
    const development = spawn(process.execPath, [process.env.npm_execpath, 'run', 'dev'], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        PENKRA_DEV_LOG_DIRECTORY: logDirectory,
        PENKRA_DEV_STATE_DIRECTORY: stateDirectory,
        PENKRA_DEV_LAUNCHER: '1',
      },
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
    writeFileSync(pidFile, `${development.pid}\n`);
    writeStatus(phase, {
      supervisorPid: process.pid,
      developmentPid: development.pid,
    });

    let developmentExit;
    development.once('exit', (code, signal) => {
      developmentExit = { code, signal };
    });

    phase = 'waiting-for-vite';
    writeStatus(phase, {
      supervisorPid: process.pid,
      developmentPid: development.pid,
      timeoutSeconds: 45,
    });

    const viteDeadline = Date.now() + 45_000;
    while (Date.now() < viteDeadline) {
      if (developmentExit) {
        throw new Error(
          `Development process exited before Vite became healthy ` +
            `(code=${developmentExit.code}, signal=${developmentExit.signal})`,
        );
      }
      if (await isHealthy()) {
        phase = 'waiting-for-electron';
        writeStatus(phase, {
          supervisorPid: process.pid,
          developmentPid: development.pid,
          timeoutSeconds: 20,
        });
        break;
      }
      await sleep(500);
    }

    if (phase !== 'waiting-for-electron') {
      throw new Error(`Vite did not become healthy at ${healthURL} within 45 seconds`);
    }

    const electronDeadline = Date.now() + 20_000;
    let electronPid;
    while (Date.now() < electronDeadline) {
      if (developmentExit) {
        throw new Error(
          `Development process exited before Electron became ready ` +
            `(code=${developmentExit.code}, signal=${developmentExit.signal})`,
        );
      }
      electronPid = readPid(electronPidFile);
      if (isAlive(electronPid)) {
        phase = 'waiting-for-renderer';
        writeStatus(phase, {
          supervisorPid: process.pid,
          developmentPid: development.pid,
          electronPid,
          timeoutSeconds: 20,
        });
        break;
      }
      await sleep(250);
    }

    if (phase !== 'waiting-for-renderer') {
      throw new Error('Electron did not report app readiness within 20 seconds');
    }

    const rendererDeadline = Date.now() + 20_000;
    while (Date.now() < rendererDeadline) {
      if (existsSync(runtimeFailureFile)) {
        const runtimeFailure = readFileSync(runtimeFailureFile, 'utf8').trim();
        throw new Error(`Electron renderer reported a startup failure: ${runtimeFailure}`);
      }
      if (existsSync(rendererReadyFile)) {
        phase = 'ready';
        writeStatus(phase, {
          supervisorPid: process.pid,
          developmentPid: development.pid,
          electronPid,
          verification: {
            developmentProcessAlive: isAlive(development.pid),
            electronProcessAlive: isAlive(electronPid),
            rendererLoaded: true,
            viteHTTP: 'ok',
          },
        });
        break;
      }
      await sleep(250);
    }

    if (phase !== 'ready') {
      throw new Error('Electron renderer did not finish loading within 20 seconds');
    }

    const { code, signal } = await new Promise((resolvePromise) => {
      if (developmentExit) {
        resolvePromise(developmentExit);
      } else {
        development.once('exit', (exitCode, exitSignal) => {
          resolvePromise({ code: exitCode, signal: exitSignal });
        });
      }
    });
    rmSync(pidFile, { force: true });
    rmSync(electronPidFile, { force: true });
    rmSync(rendererReadyFile, { force: true });
    writeStatus('stopped', {
      supervisorPid: process.pid,
      developmentPid: development.pid,
      exitCode: code,
      signal,
    });
  } catch (error) {
    rmSync(pidFile, { force: true });
    rmSync(electronPidFile, { force: true });
    rmSync(rendererReadyFile, { force: true });
    writeStatus('failed', {
      failedPhase: phase,
      failure: error instanceof Error ? error.message : String(error),
      supervisorPid: process.pid,
    });
    process.exitCode = 1;
  }
}

const command = process.argv[2];
if (command === 'launch') {
  launch();
} else if (command === 'supervise') {
  await supervise();
} else if (command === 'status') {
  await printStatus();
} else {
  process.stderr.write('Usage: dev-launcher.mjs <launch|supervise|status>\n');
  process.exitCode = 2;
}
