import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
  resolve: vi.fn(async () => "203.0.113.10"),
}));
const https = vi.hoisted(() => ({
  request: vi.fn(),
  responses: [] as Array<{ status: number; headers?: Record<string, string>; chunks?: string[] }>,
  bodies: [] as Buffer[],
}));

vi.mock("./appNetworkFetch", async () => ({
  ...(await vi.importActual<typeof import("./appNetworkFetch")>("./appNetworkFetch")),
  resolvePublicAppNetworkAddress: network.resolve,
}));

vi.mock("node:https", () => ({ request: https.request }));

import { AppTransferService } from "./appTransfer";

const roots: string[] = [];
const owner = {
  appId: "com.example.transfer",
  spaceId: "space-1",
  tabId: "tab-1",
  rendererId: 9,
  origin: `penkra-app://a-${"a".repeat(64)}`,
};

beforeEach(() => {
  https.responses.length = 0;
  https.bodies.length = 0;
  https.request.mockReset();
  https.request.mockImplementation(() => fakeRequest());
  network.resolve.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FSP.rm(root, { recursive: true, force: true })));
});

describe("AppTransferService", () => {
  it("pipes a renderer request body through one pinned, single-use endpoint", async () => {
    https.responses.push({
      status: 201,
      headers: { "content-type": "text/plain" },
      chunks: ["ok"],
    });
    const progress = vi.fn();
    const transfers = new AppTransferService({ emitProgress: progress });
    const ticket = await transfers.begin(owner, {
      url: "https://uploads.example/documents",
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
    });
    const bytes = new Uint8Array(2 * 1024 * 1024 + 3).fill(7);

    const response = await transfers.handleEndpoint(
      owner.origin,
      new Request(ticket.endpoint, { method: "POST", body: bytes }),
    );

    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe("ok");
    expect(Buffer.concat(https.bodies).equals(Buffer.from(bytes))).toBe(true);
    expect(network.resolve).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabId: owner.tabId }),
      expect.objectContaining({ id: ticket.id, phase: "uploading", movedBytes: bytes.byteLength }),
    );
    await expect(
      transfers.handleEndpoint(
        owner.origin,
        new Request(ticket.endpoint, { method: "POST", body: bytes }),
      ),
    ).rejects.toThrow("unavailable");
  });

  it("atomically receives bytes into a chosen destination and reports a digest", async () => {
    const root = await FSP.mkdtemp(Path.join(OS.tmpdir(), "penkra-transfer-"));
    roots.push(root);
    const destination = Path.join(root, "asset.bin");
    https.responses.push({
      status: 200,
      headers: { "content-length": "11" },
      chunks: ["hello ", "world"],
    });
    const progress = vi.fn();
    const assertFreeSpace = vi.fn(async () => undefined);
    const transfers = new AppTransferService({ emitProgress: progress });

    const result = await transfers.receive(
      owner,
      { url: "https://downloads.example/asset" },
      { path: destination, assertFreeSpace },
    );

    await expect(FSP.readFile(destination, "utf8")).resolves.toBe("hello world");
    expect(result).toMatchObject({
      bytes: 11,
      sha256: Crypto.createHash("sha256").update("hello world").digest("hex"),
    });
    expect(assertFreeSpace).toHaveBeenCalledWith(11);
    expect(progress).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: result.id,
        phase: "downloading",
        movedBytes: 11,
        totalBytes: 11,
      }),
    );
  });

  it("streams a file directly and wraps it as multipart when field is named", async () => {
    const root = await FSP.mkdtemp(Path.join(OS.tmpdir(), "penkra-transfer-"));
    roots.push(root);
    const source = Path.join(root, "note.txt");
    await FSP.writeFile(source, "payload");
    https.responses.push({ status: 202, chunks: ["accepted"] });
    const transfers = new AppTransferService({ emitProgress: vi.fn() });

    const result = await transfers.send(
      owner,
      { url: "https://uploads.example/files", field: "file" },
      { path: source },
    );

    expect(result).toMatchObject({ status: 202, body: "accepted" });
    const body = Buffer.concat(https.bodies).toString("utf8");
    expect(body).toContain('name="file"; filename="note.txt"');
    expect(body).toContain("payload");
  });
});

function fakeRequest() {
  const emitter = new EventEmitter() as EventEmitter & {
    write(chunk: Uint8Array): boolean;
    end(chunk?: Uint8Array): void;
    destroy(error?: Error): void;
  };
  const chunks: Buffer[] = [];
  emitter.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  emitter.end = (chunk) => {
    if (chunk?.byteLength) chunks.push(Buffer.from(chunk));
    https.bodies.push(Buffer.concat(chunks));
    const fixture = https.responses.shift();
    if (!fixture) throw new Error("Missing fake HTTPS response.");
    const response = Readable.from(
      (fixture.chunks ?? []).map((chunk) => Buffer.from(chunk)),
    ) as Readable & {
      statusCode: number;
      headers: Record<string, string>;
    };
    response.statusCode = fixture.status;
    response.headers = fixture.headers ?? {};
    queueMicrotask(() => emitter.emit("response", response));
  };
  emitter.destroy = (error) => {
    if (error) emitter.emit("error", error);
  };
  return emitter;
}
