import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { CodexAppServerManager } from "./codexAppServerManager";
import {
  ProviderProcessExitUnprovenError,
  type SupervisedProcessTeardownResult,
} from "./provider/supervisedProcessTeardown";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(childProcess.spawn).mockReset();
});
class Child extends EventEmitter {
  pid = 5588;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  close() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    this.stderr.emit("end");
    this.emit("close", 0, null);
  }
}
const input = {
  assertCurrentCredentials: Effect.void,
  key: "account",
  cwd: "/workspace",
  binaryPath: "/managed/codex",
  env: {},
  connectionId: null,
};
function setup(teardown: () => Promise<SupervisedProcessTeardownResult>) {
  const child = new Child();
  vi.mocked(childProcess.spawn).mockReturnValue(
    child as unknown as childProcess.ChildProcessWithoutNullStreams,
  );
  const manager = new CodexAppServerManager(undefined, { teardownProcessTree: teardown });
  const internals = manager as unknown as {
    getOrCreateAccountProcess: (input: unknown) => Promise<unknown>;
    sendRequest: (
      transport: unknown,
      owner: unknown,
      method: string,
      params: unknown,
    ) => Promise<unknown>;
    accountProcesses: Map<string, { transport?: unknown }>;
  };
  const startupError = new Error("Selected account initialization failed");
  vi.spyOn(internals, "sendRequest").mockRejectedValueOnce(startupError).mockResolvedValue({});
  return { child, manager, internals, startupError };
}

it("retains a failed startup's transport and retries tree proof before another spawn", async () => {
  let prove!: (result: SupervisedProcessTeardownResult) => void;
  const finalProof = new Promise<SupervisedProcessTeardownResult>((resolve) => {
    prove = resolve;
  });
  const failedProof = new ProviderProcessExitUnprovenError({
    rootPid: 5588,
    rootExited: false,
    remainingDescendantPids: [5589],
    captureComplete: true,
  });
  const teardown = vi
    .fn()
    .mockRejectedValueOnce(failedProof)
    .mockRejectedValueOnce(failedProof)
    .mockReturnValueOnce(finalProof);
  const f = setup(teardown);
  await expect(f.internals.getOrCreateAccountProcess(input)).rejects.toBe(f.startupError);
  expect(f.internals.accountProcesses.get("account")?.transport).toBeDefined();
  await expect(f.internals.getOrCreateAccountProcess(input)).rejects.toThrow(
    "Failed to prove Codex account process-tree exit",
  );
  expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  expect(f.internals.accountProcesses.has("account")).toBe(true);
  const nextChild = new Child();
  vi.mocked(childProcess.spawn).mockReturnValueOnce(
    nextChild as unknown as childProcess.ChildProcessWithoutNullStreams,
  );
  const retiring = f.internals.getOrCreateAccountProcess(input).catch((error) => error);
  await Promise.resolve();
  expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  f.child.close();
  prove({ escalated: true, signalErrors: [] });
  expect(await retiring).toMatchObject({
    message: "Codex account process stopped before admission.",
  });
  expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  const replacement = await f.internals.getOrCreateAccountProcess(input);
  expect(replacement).toMatchObject({ child: nextChild });
  expect(childProcess.spawn).toHaveBeenCalledTimes(2);
  expect(teardown).toHaveBeenCalledTimes(3);
});

it("deletes the entry when startup fails before a child is spawned", async () => {
  const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
  const f = setup(teardown);
  const error = new Error("Spawn rejected before creating a process");
  vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
    throw error;
  });
  await expect(f.internals.getOrCreateAccountProcess(input)).rejects.toBe(error);
  expect(f.internals.accountProcesses.has("account")).toBe(false);
  expect(teardown).not.toHaveBeenCalled();
});

it("deletes the entry when failed startup's tree proof succeeds", async () => {
  const teardown = vi.fn(async (): Promise<SupervisedProcessTeardownResult> => {
    f.child.close();
    return { escalated: false, signalErrors: [] };
  });
  const f = setup(teardown);
  await expect(f.internals.getOrCreateAccountProcess(input)).rejects.toBe(f.startupError);
  expect(f.internals.accountProcesses.has("account")).toBe(false);
  expect(teardown).toHaveBeenCalledOnce();
});
