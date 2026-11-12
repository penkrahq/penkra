// FILE: processTreeKiller.ts
// Purpose: Captures and terminates child process trees without losing reparented children.
// Layer: Shared process infrastructure utility
// Depends on: node child_process, process signals, and tree-kill.
import { spawn } from "node:child_process";

import treeKill from "tree-kill";

const PROCESS_TREE_SCAN_TIMEOUT_MS = 1_000;
// Full-system `ps` output scales with host process count and command-line
// length (Electron helpers alone run to kilobytes per line); an undersized cap
// makes snapshot failure routine on busy machines.
const PROCESS_TREE_SCAN_MAX_BUFFER_BYTES = 8_388_608;
const POSIX_TREE_WALK_MAX_VISITED = 256;

export type ProcessChildrenMap = Map<number, Array<CapturedProcess>>;
export type ProcessCommandMap = Map<number, string>;

export interface CapturedProcess {
  pid: number;
  command: string;
}

export interface CapturedProcessTree {
  descendants: CapturedProcess[];
  /** False when the platform process snapshot failed and descendant absence is unproven. */
  captureComplete?: boolean;
}

export interface CapturedProcessTreeInspection {
  /** False when the process table could not be read, so exit cannot be proven. */
  verified: boolean;
  survivors: CapturedProcess[];
}

export type TerminalKillSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTreeKiller {
  capture(rootPid: number): CapturedProcessTree | Promise<CapturedProcessTree>;
  inspect?(
    tree: CapturedProcessTree,
  ): CapturedProcessTreeInspection | Promise<CapturedProcessTreeInspection>;
  signal(input: {
    rootPid: number;
    signal: TerminalKillSignal;
    tree: CapturedProcessTree;
    includeRootTree?: boolean | undefined;
    onError: (error: Error, context: { pid: number; source: "tree-kill" | "captured" }) => void;
  }): unknown;
}

export interface ProcessTreeKillerDependencies {
  captureChildrenMap: () => ProcessChildrenMap | null | Promise<ProcessChildrenMap | null>;
  readCurrentCommands: (
    pids: readonly number[],
  ) => ProcessCommandMap | null | Promise<ProcessCommandMap | null>;
  signalPid: (pid: number, signal: TerminalKillSignal) => Error | null;
  signalTree: (
    rootPid: number,
    signal: TerminalKillSignal,
    callback: (error?: Error | null) => void,
  ) => void;
}

export function parseProcessChildrenMap(psOutput: string): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, ...commandParts] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const command = commandParts.join(" ").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (command.length === 0) continue;
    const siblings = childrenByParentPid.get(ppid) ?? [];
    siblings.push({ pid, command });
    childrenByParentPid.set(ppid, siblings);
  }
  return childrenByParentPid;
}

export function parseProcessCommandMap(psOutput: string): ProcessCommandMap {
  const commandsByPid: ProcessCommandMap = new Map();
  for (const line of psOutput.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]?.trim() ?? "";
    if (!Number.isInteger(pid) || command.length === 0) continue;
    commandsByPid.set(pid, command);
  }
  return commandsByPid;
}

export function collectDescendantProcesses(
  parentPid: number,
  childrenByParentPid: ProcessChildrenMap,
): CapturedProcess[] {
  const descendants: CapturedProcess[] = [];
  const stack = [...(childrenByParentPid.get(parentPid) ?? [])].reverse();
  const visited = new Set<number>([parentPid]);

  while (stack.length > 0 && descendants.length < POSIX_TREE_WALK_MAX_VISITED) {
    const child = stack.pop();
    if (!child || visited.has(child.pid)) {
      continue;
    }
    visited.add(child.pid);
    descendants.push(child);

    const nestedChildren = childrenByParentPid.get(child.pid) ?? [];
    for (const nestedChild of [...nestedChildren].reverse()) {
      stack.push(nestedChild);
    }
  }

  return descendants;
}

// One bounded process-table scan is shared by concurrent callers. A stalled
// child is not replaced until it exits, preventing an accumulation of ps jobs.
type ProcessSnapshot = { children: ProcessChildrenMap; rss: Map<number, number> };
let activeScan: Promise<ProcessSnapshot | null> | undefined;
let cachedScan: { at: number; value: ProcessSnapshot } | undefined;
function captureProcessSnapshot(fresh = false): Promise<ProcessSnapshot | null> {
  if (!fresh && cachedScan && Date.now() - cachedScan.at < 250)
    return Promise.resolve(cachedScan.value);
  if (activeScan) return activeScan;
  activeScan = new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ps", ["-eo", "pid=,ppid=,rss=,command="], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      queueMicrotask(() => {
        activeScan = undefined;
      });
      resolve(null);
      return;
    }
    let text = "";
    let finished = false;
    const finish = (value: ProcessSnapshot | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (value) cachedScan = { at: Date.now(), value };
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null);
      child.kill("SIGKILL");
    }, PROCESS_TREE_SCAN_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (finished) return;
      text += chunk;
      if (Buffer.byteLength(text) > PROCESS_TREE_SCAN_MAX_BUFFER_BYTES) {
        finish(null);
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => {
      finish(null);
      activeScan = undefined;
    });
    child.on("close", (code) => {
      if (code === 0 && !finished) {
        const rss = new Map<number, number>();
        const lines: string[] = [];
        for (const line of text.split(/\r?\n/u)) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/u.exec(line);
          if (!match) continue;
          rss.set(Number(match[1]), Number(match[3]) * 1024);
          lines.push(`${match[1]} ${match[2]} ${match[4]}`);
        }
        finish({ children: parseProcessChildrenMap(lines.join("\n")), rss });
      } else finish(null);
      activeScan = undefined;
    });
  });
  return activeScan;
}

async function captureProcessChildrenMap(): Promise<ProcessChildrenMap | null> {
  return (await captureProcessSnapshot())?.children ?? null;
}

export async function readProcessRss(pid: number): Promise<number> {
  const snapshot = await captureProcessSnapshot();
  const value = snapshot?.rss.get(pid);
  if (value === undefined) throw new Error("Process RSS was unavailable.");
  return value;
}

async function readCurrentCommands(pids: readonly number[]): Promise<ProcessCommandMap | null> {
  if (pids.length === 0) return new Map();
  const table = (await captureProcessSnapshot(true))?.children;
  if (!table) return null;
  const wanted = new Set(pids);
  const commands: ProcessCommandMap = new Map();
  for (const children of table.values())
    for (const child of children) if (wanted.has(child.pid)) commands.set(child.pid, child.command);
  return commands;
}

function signalPid(pid: number, signal: TerminalKillSignal): Error | null {
  try {
    globalThis.process.kill(pid, signal);
    return null;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno?.code === "ESRCH") {
      return null;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function shouldSignalCapturedProcess(
  process: CapturedProcess,
  signal: TerminalKillSignal,
  currentCommands: ProcessCommandMap | null,
): boolean {
  if (signal !== "SIGKILL") {
    return true;
  }
  return currentCommands?.get(process.pid) === process.command;
}

async function capturedProcessesForSignal(
  descendants: readonly CapturedProcess[],
  signal: TerminalKillSignal,
  readCommands: (
    pids: readonly number[],
  ) => ProcessCommandMap | null | Promise<ProcessCommandMap | null>,
): Promise<CapturedProcess[]> {
  const currentCommands =
    signal === "SIGKILL"
      ? await readCommands(descendants.map((descendant) => descendant.pid))
      : null;
  return descendants.filter((descendant) =>
    shouldSignalCapturedProcess(descendant, signal, currentCommands),
  );
}

// Creates an injectable killer so tests can exercise PID-reuse safeguards safely.
export function createProcessTreeKiller(
  dependencies: Partial<ProcessTreeKillerDependencies> = {},
): ProcessTreeKiller {
  const deps: ProcessTreeKillerDependencies = {
    captureChildrenMap: captureProcessChildrenMap,
    readCurrentCommands,
    signalPid,
    signalTree: treeKill,
    ...dependencies,
  };

  return {
    capture: async (rootPid) => {
      if (!Number.isInteger(rootPid) || rootPid <= 0) {
        return { descendants: [], captureComplete: false };
      }
      if (globalThis.process.platform === "win32") {
        // tree-kill delegates to taskkill /T on Windows, which owns descendant traversal.
        return { descendants: [], captureComplete: true };
      }
      const childrenByParentPid = await deps.captureChildrenMap();
      if (!childrenByParentPid) return { descendants: [], captureComplete: false };
      return {
        descendants: collectDescendantProcesses(rootPid, childrenByParentPid),
        captureComplete: true,
      };
    },
    inspect: async (tree) => {
      if (tree.descendants.length === 0) {
        return { verified: true, survivors: [] };
      }
      const currentCommands = await deps.readCurrentCommands(
        tree.descendants.map((descendant) => descendant.pid),
      );
      if (currentCommands === null) {
        return { verified: false, survivors: [...tree.descendants] };
      }
      return {
        verified: true,
        survivors: tree.descendants.filter(
          (descendant) => currentCommands.get(descendant.pid) === descendant.command,
        ),
      };
    },
    signal: async ({ rootPid, signal, tree, includeRootTree = true, onError }) => {
      // Do not wait on a fresh descendant scan before signalling a live root:
      // it could exit and its PID could be reused while the scan is pending.
      if (includeRootTree && globalThis.process.platform !== "win32") {
        const error = deps.signalPid(rootPid, signal);
        if (error) onError(error, { pid: rootPid, source: "tree-kill" });
      }
      // Signal captured descendants directly as well as through tree-kill. If
      // the PTY root exits, those children may be reparented before escalation.
      const capturedProcesses = await capturedProcessesForSignal(
        tree.descendants,
        signal,
        deps.readCurrentCommands,
      );
      for (const descendant of capturedProcesses.toReversed()) {
        const error = deps.signalPid(descendant.pid, signal);
        if (error) {
          onError(error, { pid: descendant.pid, source: "captured" });
        }
      }
      if (includeRootTree) {
        if (globalThis.process.platform === "win32") {
          deps.signalTree(rootPid, signal, (err) => {
            if (err) onError(err, { pid: rootPid, source: "tree-kill" });
          });
        }
      }
    },
  };
}

export const defaultProcessTreeKiller: ProcessTreeKiller = createProcessTreeKiller();
