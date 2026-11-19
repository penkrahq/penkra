import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import { LocalModelSupervisor } from "./localModelSupervisor.ts";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess & { stderr: PassThrough };
  Object.assign(child, { stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = (() => {
    (child as { exitCode: number | null }).exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0));
    return true;
  }) as ChildProcess["kill"];
  return child;
}

function setup() {
  const spawned: { args: string[]; child: ReturnType<typeof fakeChild> }[] = [];
  let port = 9000;
  const supervisor = new LocalModelSupervisor({
    spawnProcess: (_cmd, args) => {
      const child = fakeChild();
      spawned.push({ args, child });
      return child;
    },
    fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    freePort: async () => port++,
  });
  return { supervisor, spawned };
}

const spec = (modelId: string) => ({ modelId, pythonPath: "/py", modelPath: `/models/${modelId}` });

describe("LocalModelSupervisor", () => {
  it("starts one server with small prefill steps and reuses it", async () => {
    const { supervisor, spawned } = setup();
    expect(await supervisor.ensure(spec("a"))).toBe("http://127.0.0.1:9000/v1");
    expect(await supervisor.ensure(spec("a"))).toBe("http://127.0.0.1:9000/v1");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toContain("--prefill-step-size");
    await supervisor.stop();
  });

  it("switches models by stopping the old server", async () => {
    const { supervisor, spawned } = setup();
    await supervisor.ensure(spec("a"));
    await supervisor.ensure(spec("b"));
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.child.exitCode).toBe(0);
    await supervisor.stop();
  });

  it("restarts after the generation thread dies", async () => {
    const { supervisor, spawned } = setup();
    await supervisor.ensure(spec("a"));
    spawned[0]!.child.stderr.write("ERROR - mlx_lm.server generation thread died: [METAL] ...\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(await supervisor.ensure(spec("a"))).toBe("http://127.0.0.1:9001/v1");
    expect(spawned).toHaveLength(2);
    await supervisor.stop();
  });

  it("restarts after a reported request failure", async () => {
    const { supervisor, spawned } = setup();
    await supervisor.ensure(spec("a"));
    supervisor.reportFailure("a");
    await supervisor.ensure(spec("a"));
    expect(spawned).toHaveLength(2);
    await supervisor.stop();
  });
});
