import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import {
  makeProviderProcessDiagnostics,
  observeProviderProcess,
} from "./providerProcessDiagnostics.ts";

it("reads an actual OS memory observation without a polling timer", async () => {
  const write = vi.fn();
  const diagnostics = makeProviderProcessDiagnostics({
    provider: "opencode",
    pid: process.pid,
    write,
  });
  await diagnostics.sampleMemory();
  diagnostics.recordExit(0, null);
  expect(write.mock.calls[0]![0].lastRssBytes).toBeGreaterThan(0);
  expect(write.mock.calls[0]![0].memoryError).toBeNull();
});

it("records the native exit and final drained stderr without changing process behavior", async () => {
  const events: Readonly<Record<string, unknown>>[] = [];
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stdin.once('data',()=>{process.stderr.write('last native error');process.exit(7)})",
    ],
    { stdio: "pipe" },
  );
  const diagnostics = observeProviderProcess(child, {
    provider: "codex",
    readMemory: async () => 1234,
    write: (event) => {
      events.push(event);
    },
    context: () => ({ requestedStop: false, threadIds: ["one", "two"] }),
  });
  await diagnostics.sampleMemory();
  child.stdin.end("finish");
  const [code, signal] = await once(child, "close");
  expect([code, signal]).toEqual([7, null]);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    provider: "codex",
    pid: child.pid,
    phase: "exit",
    code: 7,
    signal: null,
    lastRssBytes: 1234,
    requestedStop: false,
    threadIds: ["one", "two"],
  });
  expect(events[1]).toMatchObject({ phase: "closed", stderr: "last native error" });
  expect(events[1]?.uptimeMs).toBeGreaterThanOrEqual(0);
});

it("bounds stderr, redacts split credentials, and does not invent memory observations", async () => {
  const write = vi.fn();
  const readMemory = vi.fn(async () => {
    throw new Error("process already exited");
  });
  const diagnostics = makeProviderProcessDiagnostics({
    provider: "claudeAgent",
    pid: 123,
    write,
    readMemory,
  });
  diagnostics.appendStderr("x".repeat(10000));
  diagnostics.appendStderr("\nauthorization=sk-fake-secret-");
  diagnostics.appendStderr("012345678901234567890123456789 end");
  await diagnostics.sampleMemory();
  diagnostics.recordExit(null, "SIGKILL");
  await diagnostics.sampleMemory();
  const event = write.mock.calls[0]![0];
  expect(event.stderr).not.toContain("fake-secret");
  expect(event.stderr).not.toContain("012345678901234567890123456789");
  expect(event.stderr.length).toBeLessThanOrEqual(4096);
  expect(event).toMatchObject({
    code: null,
    signal: "SIGKILL",
    lastRssBytes: null,
    rssSampleAgeMs: null,
    memoryError: "process already exited",
  });
  expect(readMemory).toHaveBeenCalledTimes(1);
});
