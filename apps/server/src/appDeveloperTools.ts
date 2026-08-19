import { spawn } from "node:child_process";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { defaultProcessTreeKiller } from "./terminal/processTreeKiller";

const APP_TEST_HOST_STOP_TIMEOUT_MS = 1_000;

export { packageAppDirectory, type AppPackageEvidence } from "@penkra/shared/appPackaging";

export interface AppIntegrationTestEvidence {
  ok: true;
  appId: string;
  version: string;
  tab: { id: string; status: "ready" };
  diagnostics: ReadonlyArray<{ kind: string }>;
  profileRemoved: true;
}

export async function testAppDirectory(input: {
  directory: string;
  timeoutMs?: number;
}): Promise<AppIntegrationTestEvidence> {
  const source = await FS.realpath(Path.resolve(input.directory));
  const { electron, host } = await resolveAppTestRuntime();
  const profile = await FS.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-test-"));
  const resultPath = Path.join(profile, "result.json");
  try {
    await spawnAppTestHost({
      electron,
      host,
      source,
      profile,
      resultPath,
      timeoutMs: input.timeoutMs ?? 30_000,
    });
    const result = JSON.parse(await FS.readFile(resultPath, "utf8")) as Record<string, unknown>;
    if (result.ok !== true)
      throw new Error(
        typeof result.error === "string" ? result.error : "The App integration host failed.",
      );
    const tab = result.tab as Record<string, unknown> | undefined;
    if (!tab || tab.status !== "ready" || typeof tab.id !== "string")
      throw new Error("The App tab did not reach ready state.");
    const diagnostics = Array.isArray(result.diagnostics)
      ? (result.diagnostics as Array<{ kind: string }>)
      : [];
    if (!diagnostics.some((entry) => entry.kind === "tab-ready"))
      throw new Error("The App test did not produce tab-ready diagnostics.");
    return {
      ok: true,
      appId: String(result.appId),
      version: String(result.version),
      tab: { id: tab.id, status: "ready" },
      diagnostics,
      profileRemoved: true,
    };
  } finally {
    await FS.rm(profile, { recursive: true, force: true });
  }
}

async function resolveAppTestRuntime(): Promise<{ electron: string; host: string }> {
  const provided = {
    electron: process.env.PENKRA_APP_TEST_ELECTRON?.trim(),
    host: process.env.PENKRA_APP_TEST_HOST?.trim(),
    packaged: process.env.PENKRA_APP_TEST_PACKAGED?.trim() === "1",
  };
  if (provided.electron && provided.host) {
    const runtime = {
      electron: provided.electron,
      host: provided.packaged ? "" : provided.host,
    };
    for (const [label, path] of Object.entries(runtime)) {
      if (!path && label === "host" && provided.packaged) continue;
      if (!Path.isAbsolute(path))
        throw new Error(`Penkra App test ${label} path must be absolute.`);
      const stat = await FS.stat(path).catch(() => null);
      if (!stat?.isFile()) throw new Error(`Penkra App test ${label} is unavailable.`);
    }
    return { electron: runtime.electron, host: runtime.host };
  }
  throw new Error("App testing is available only inside a running Penkra desktop.");
}

function spawnAppTestHost(input: {
  electron: string;
  host: string;
  source: string;
  profile: string;
  resultPath: string;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PENKRA_INTERNAL_DESKTOP_MODE: "app-test",
      PENKRA_APP_TEST_SOURCE: input.source,
      PENKRA_APP_TEST_PROFILE: input.profile,
      PENKRA_APP_TEST_RESULT: input.resultPath,
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(input.electron, input.host ? [input.host] : [], {
      cwd: input.host ? Path.dirname(input.host) : process.cwd(),
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let terminating = false;
    let resolveExited: (() => void) | undefined;
    const childExited = new Promise<void>((resolveExit) => {
      resolveExited = resolveExit;
    });
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timeout = setTimeout(() => {
      if (settled || terminating) return;
      terminating = true;
      void stopTimedOutAppTestHost(child, childExited).then((cleanupFailure) => {
        if (settled) return;
        settled = true;
        const timeoutMessage = appTestHostFailure(
          `App integration test exceeded ${input.timeoutMs} ms.`,
          output,
        );
        reject(
          new Error(
            cleanupFailure
              ? `${timeoutMessage}\nApp test cleanup failed: ${cleanupFailure}`
              : timeoutMessage,
          ),
        );
      });
    }, input.timeoutMs);
    child.once("error", (error) => {
      resolveExited?.();
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      resolveExited?.();
      if (settled || terminating) return;
      settled = true;
      clearTimeout(timeout);
      if (
        code === 0 ||
        (await FS.stat(input.resultPath)
          .then(() => true)
          .catch(() => false))
      ) {
        resolve();
      } else {
        reject(
          new Error(
            appTestHostFailure(
              `App integration host failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}.`,
              output,
            ),
          ),
        );
      }
    });
  });
}

async function stopTimedOutAppTestHost(
  child: ReturnType<typeof spawn>,
  childExited: Promise<void>,
): Promise<string | null> {
  const rootPid = child.pid;
  if (!rootPid) {
    child.kill("SIGKILL");
    return null;
  }

  const tree = defaultProcessTreeKiller.capture(rootPid);
  const signalErrors: string[] = [];
  const signal = (signalName: "SIGTERM" | "SIGKILL", includeRootTree = true) => {
    defaultProcessTreeKiller.signal({
      rootPid,
      signal: signalName,
      tree,
      includeRootTree,
      onError: (error, context) => {
        signalErrors.push(`${context.source}:${context.pid}:${error.message}`);
      },
    });
  };

  signal("SIGTERM");
  const rootExited = await waitForExit(childExited, APP_TEST_HOST_STOP_TIMEOUT_MS);
  const afterTerm = defaultProcessTreeKiller.inspect?.(tree);
  if (!rootExited || !afterTerm?.verified || afterTerm.survivors.length > 0) {
    signal("SIGKILL", !rootExited);
    await waitForExit(childExited, APP_TEST_HOST_STOP_TIMEOUT_MS);
  }

  const finalInspection = defaultProcessTreeKiller.inspect?.(tree);
  if (finalInspection?.verified && finalInspection.survivors.length === 0) return null;
  if (finalInspection && !finalInspection.verified) {
    return `descendant cleanup could not be verified${signalErrors.length ? ` (${signalErrors.join(", ")})` : ""}`;
  }
  if (finalInspection?.survivors.length) {
    return `renderer helpers remain live: ${finalInspection.survivors.map(({ pid }) => pid).join(", ")}`;
  }
  return signalErrors.length ? signalErrors.join(", ") : null;
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exited.then(() => true as const), timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

function appTestHostFailure(message: string, output: string): string {
  const detail = output.trim();
  return detail ? `${message}\n${detail}` : message;
}
