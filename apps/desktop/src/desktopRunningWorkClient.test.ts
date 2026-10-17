import { describe, expect, it, vi } from "vitest";
import { DesktopRunningWorkClient } from "./desktopRunningWorkClient";

function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    response: new Response(body),
    controller,
    send: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
  };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DesktopRunningWorkClient", () => {
  it("decodes split UTF-8/NDJSON states and releases on EOF without a retry", async () => {
    const input = source();
    const received = latch();
    const states: ReadonlyArray<string>[] = [];
    const onError = vi.fn();
    const fetcher = vi.fn(async () => input.response);
    const client = new DesktopRunningWorkClient({
      fetcher: fetcher as typeof fetch,
      onError,
      onWorking: (ids) => {
        states.push(ids);
        if (ids[0] === "café") received.resolve();
      },
    });
    const running = client.start({ url: "http://backend.test", token: "fixture" });
    const bytes = new TextEncoder().encode('{"working":["café"]}\n{"working":[]}\n');
    const split = bytes.indexOf(0xc3) + 1;
    input.controller.enqueue(bytes.slice(0, split));
    input.controller.enqueue(bytes.slice(split));
    await received.promise;
    input.controller.close();
    await running;
    expect(states).toContainEqual(["café"]);
    expect(states.at(-1)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "http://backend.test/api/desktop/running-work",
      expect.objectContaining({ headers: { Authorization: "Bearer fixture" } }),
    );
  });
  it.each(['{"working":null}\n', '{"working":["a"]}'])(
    "reports invalid or truncated state and releases: %s",
    async (text) => {
      const input = source();
      const onWorking = vi.fn();
      const onError = vi.fn();
      const client = new DesktopRunningWorkClient({
        onWorking,
        onError,
        fetcher: vi.fn(async () => input.response) as typeof fetch,
      });
      const running = client.start({ url: "http://backend.test", token: "fixture" });
      input.send(text);
      input.controller.close();
      await running;
      expect(onError).toHaveBeenCalledOnce();
      expect(onWorking).toHaveBeenLastCalledWith([]);
    },
  );
  it("an older stream ending cannot clear a replacement backend's work", async () => {
    const old = source();
    const next = source();
    const first = latch();
    const second = latch();
    const states: ReadonlyArray<string>[] = [];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(old.response)
      .mockResolvedValueOnce(next.response);
    const client = new DesktopRunningWorkClient({
      fetcher,
      onError: vi.fn(),
      onWorking: (ids) => {
        states.push(ids);
        if (ids[0] === "old") first.resolve();
        if (ids[0] === "new") second.resolve();
      },
    });
    const oldRun = client.start({ url: "http://old.test", token: "fixture" });
    old.send('{"working":["old"]}\n');
    await first.promise;
    const nextRun = client.start({ url: "http://new.test", token: "fixture" });
    next.send('{"working":["new"]}\n');
    await second.promise;
    old.controller.close();
    await oldRun;
    expect(states.at(-1)).toEqual(["new"]);
    client.stop();
    expect(states.at(-1)).toEqual([]);
    next.controller.close();
    await nextRun;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it("reports an HTTP failure once and leaves no work assertion", async () => {
    const onWorking = vi.fn();
    const onError = vi.fn();
    const fetcher = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const client = new DesktopRunningWorkClient({
      onWorking,
      onError,
      fetcher: fetcher as typeof fetch,
    });
    await client.start({ url: "http://backend.test", token: "fixture" });
    expect(onWorking).toHaveBeenLastCalledWith([]);
    expect(onError).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
