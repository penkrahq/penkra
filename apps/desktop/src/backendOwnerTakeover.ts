// Identifies a stuck installed backend without relying on the process table.
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type Owner = { pid: number; token: string; createdAt: string; startedAt: number; origin: string };

type Options = { stateDir: string; executable: string; helper: string; ownerPid: number };

async function ownerIdentity(options: Options): Promise<Owner | null> {
  try {
    const lockDir = path.join(options.stateDir, "state.sqlite.lifecycle-lock");
    const lockStat = await fs.lstat(lockDir);
    const ownerPath = path.join(lockDir, "owner.json");
    const ownerStat = await fs.lstat(ownerPath);
    if (
      !lockStat.isDirectory() ||
      lockStat.isSymbolicLink() ||
      !ownerStat.isFile() ||
      ownerStat.isSymbolicLink()
    )
      return null;
    const owner: unknown = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    const runtime: unknown = JSON.parse(
      await fs.readFile(path.join(options.stateDir, "server-runtime.json"), "utf8"),
    );
    if (!owner || typeof owner !== "object" || !runtime || typeof runtime !== "object") return null;
    const o = owner as Record<string, unknown>;
    const r = runtime as Record<string, unknown>;
    if (
      o.pid !== options.ownerPid ||
      r.pid !== o.pid ||
      typeof o.token !== "string" ||
      typeof o.createdAt !== "string" ||
      typeof r.origin !== "string"
    )
      return null;
    const url = new URL(r.origin);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    const { stdout } = await execFileAsync(options.helper, ["--process-identity", String(o.pid)], {
      timeout: 1000,
      maxBuffer: 4096,
    });
    const identity: unknown = JSON.parse(stdout);
    if (!identity || typeof identity !== "object") return null;
    const i = identity as Record<string, unknown>;
    const lockTime = Date.parse(o.createdAt);
    const installedServer = path.join(
      path.dirname(options.executable),
      "../Resources/app.asar/apps/server/dist/index.mjs",
    );
    if (
      typeof i.path !== "string" ||
      typeof i.startedAt !== "number" ||
      !Number.isFinite(lockTime) ||
      i.startedAt * 1000 > lockTime + 1000 ||
      (await fs.realpath(i.path)) !== (await fs.realpath(options.executable)) ||
      !Array.isArray(i.arguments) ||
      !i.arguments.includes(installedServer)
    )
      return null;
    return {
      pid: options.ownerPid,
      token: o.token,
      createdAt: o.createdAt,
      startedAt: i.startedAt,
      origin: url.origin,
    };
  } catch {
    return null;
  }
}

async function unresponsive(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/status`, { signal: AbortSignal.timeout(3000), redirect: "error" });
    return false;
  } catch {
    return true;
  }
}

export async function findStuckBackend(options: Options): Promise<Owner | null> {
  const owner = await ownerIdentity(options);
  return owner && (await unresponsive(owner.origin)) ? owner : null;
}

export async function stopStuckBackend(options: Options, expected: Owner): Promise<boolean> {
  const current = await findStuckBackend(options);
  if (
    !current ||
    current.pid !== expected.pid ||
    current.token !== expected.token ||
    current.createdAt !== expected.createdAt ||
    current.startedAt !== expected.startedAt
  )
    return false;
  try {
    process.kill(current.pid, "SIGCONT");
    process.kill(current.pid, "SIGTERM");
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(current.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        return false;
      }
    }
    const last = await findStuckBackend(options);
    if (!last || last.token !== expected.token || last.startedAt !== expected.startedAt)
      return false;
    process.kill(last.pid, "SIGKILL");
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(last.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        return false;
      }
    }
  } catch {
    return false;
  }
  return false;
}
