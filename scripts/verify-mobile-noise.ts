// Local cross-repository check: production Node/CryptoKit implementations over
// the actual container relay. No shared development/Production state is used.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import {
  createNoiseIdentity,
  NoiseHandshake,
  noisePairingCode,
  noisePublicKey,
} from "../apps/server/src/remoteLink/noise";

const [mobileArgument, backendArgument] = process.argv.slice(2);
if (!mobileArgument || !backendArgument)
  throw new Error(
    "Usage: bun scripts/verify-mobile-noise.ts <penkra-app> <penkra-backend-mobile-client-auth>",
  );
const mobile = resolve(mobileArgument),
  backend = resolve(backendArgument);
const base = resolve(".penkra/scratch/mobile-noise");
await mkdir(base, { recursive: true });
const scratch = await mkdtemp(join(base, "cross-"));
const run = promisify(execFile);
const dockerArgs = ["compose", "-p", "penkra-mobile-relay-qa", "-f", "apps/relay/compose.qa.yml"];
const compose = (...args: string[]) =>
  execFileSync("docker", [...dockerArgs, ...args], { cwd: backend, encoding: "utf8" });
const sql = (statement: string) =>
  compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "penkra_mobile_relay_qa",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    statement,
  );
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const unhex = (value: string) => Buffer.from(value, "hex");
const credentialValues: string[] = [];
const sockets: WebSocket[] = [];
const children: ReturnType<typeof spawn>[] = [];
let composeStarted = false;
try {
  const binary = join(scratch, "noise-checks");
  await run("/usr/bin/swiftc", [
    join(mobile, "PenkraMobile/Noise.swift"),
    join(mobile, "QA/NoiseChecks.swift"),
    "-o",
    binary,
  ]);
  const vectors = await run(binary, [
    "vectors",
    resolve("apps/server/src/remoteLink/fixtures/cacophony.json"),
  ]);
  process.stdout.write(vectors.stdout);
  await run("pnpm", ["--filter", "@penkra/relay", "build"], { cwd: backend });
  const { encodeFrame, decodeFrame, FrameType, OpenMode } = await import(
    pathToFileURL(join(backend, "apps/relay/dist/protocol.js")).href
  );
  composeStarted = true;
  compose("up", "-d", "--build", "--wait");
  const address = compose("port", "relay", "3013").trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  sql(
    `INSERT INTO public."user"(id,name,email,"emailVerified") VALUES ('noise-cross','QA','noise-cross@example.test',true)`,
  );
  const connect = async (token: string) => {
    const socket = new WebSocket(`ws://${address}/v1`, {
      headers: { authorization: `Bearer ${token}`, "Penkra-Relay-Version": "1" },
    });
    sockets.push(socket);
    socket.on("error", () => undefined);
    const frames: ReturnType<typeof decodeFrame>[] = [];
    let wake: (() => void) | undefined;
    socket.on("message", (data) => {
      frames.push(decodeFrame(data as Buffer));
      wake?.();
    });
    await once(socket, "open");
    return {
      socket,
      async next(type: number) {
        for (;;) {
          const index = frames.findIndex((frame) => frame.type === type);
          if (index >= 0) return frames.splice(index, 1)[0]!;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      },
    };
  };
  for (const pattern of ["XX", "KK"] as const) {
    const macId = randomUUID(),
      phoneId = randomUUID();
    const macKey = createNoiseIdentity(),
      phoneKey = createNoiseIdentity();
    const prologue = Buffer.concat([
      Buffer.from("penkra-remote/1"),
      unhex(macId.replaceAll("-", "")),
      unhex(phoneId.replaceAll("-", "")),
    ]);
    const macToken = randomBytes(32).toString("base64url"),
      phoneToken = randomBytes(32).toString("base64url");
    credentialValues.push(macToken, phoneToken);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    sql(`INSERT INTO devices(id,account_id,kind,name,model,app_version,identity_key,token_hash) VALUES
      ('${macId}','noise-cross','mac','Mac','Mac','qa',decode('${hex(noisePublicKey(macKey))}','hex'),decode('${hash(macToken)}','hex')),
      ('${phoneId}','noise-cross','phone','Phone','Phone','qa',decode('${hex(noisePublicKey(phoneKey))}','hex'),decode('${hash(phoneToken)}','hex'));
      ${pattern === "KK" ? `INSERT INTO device_pairings(mac_device_id,phone_device_id) VALUES ('${macId}','${phoneId}');` : ""}`);
    const mac = await connect(macToken),
      phone = await connect(phoneToken);
    const child = spawn(binary, ["peer"], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const swift = async (command: Record<string, unknown>): Promise<Record<string, string>> => {
      child.stdin!.write(JSON.stringify(command) + "\n");
      const line = await lines.next();
      if (line.done) throw new Error("Swift cryptographic peer exited unexpectedly");
      return JSON.parse(line.value);
    };
    const node = new NoiseHandshake({
      pattern,
      initiator: false,
      staticPrivateKey: macKey,
      prologue,
      ...(pattern === "KK" ? { remoteStaticKey: noisePublicKey(phoneKey) } : {}),
    });
    assert.equal(
      (
        await swift({
          op: "init",
          pattern,
          initiator: true,
          staticKey: hex(phoneKey),
          prologue: hex(prologue),
          ...(pattern === "KK" ? { remoteStaticKey: hex(noisePublicKey(macKey)) } : {}),
        })
      ).ready,
      "true",
    );
    const sessionId = randomUUID();
    const initial = await swift({ op: "write" });
    phone.socket.send(
      encodeFrame({
        type: FrameType.OPEN,
        mode: pattern === "XX" ? OpenMode.PAIRING : OpenMode.SESSION,
        sessionId,
        peerId: macId,
        payload: unhex(initial.message!),
      }),
    );
    node.readMessage((await mac.next(FrameType.OPEN)).payload);
    mac.socket.send(
      encodeFrame({
        type: FrameType.DATA,
        sessionId,
        peerId: phoneId,
        payload: node.writeMessage(),
      }),
    );
    assert.equal(
      (await swift({ op: "read", message: hex((await phone.next(FrameType.DATA)).payload) }))
        .payload,
      "",
    );
    if (pattern === "XX") {
      const third = await swift({ op: "write" });
      phone.socket.send(
        encodeFrame({
          type: FrameType.DATA,
          sessionId,
          peerId: macId,
          payload: unhex(third.message!),
        }),
      );
      node.readMessage((await mac.next(FrameType.DATA)).payload);
    }
    const peer = await swift({ op: "finish" }),
      transport = node.finish();
    assert.equal(peer.hash, hex(transport.handshakeHash));
    assert.equal(peer.code, noisePairingCode(transport.handshakeHash));
    assert.equal(peer.remoteStaticKey, hex(noisePublicKey(macKey)));
    assert.equal(hex(transport.remoteStaticKey), hex(noisePublicKey(phoneKey)));
    const plain = Buffer.from(`sensitive-noise-fixture-${pattern}`);
    const encrypted = await swift({ op: "encrypt", payload: hex(plain) });
    phone.socket.send(
      encodeFrame({
        type: FrameType.DATA,
        sessionId,
        peerId: macId,
        payload: unhex(encrypted.ciphertext!),
      }),
    );
    assert.deepEqual(
      Buffer.from(transport.receive.decrypt((await mac.next(FrameType.DATA)).payload)),
      plain,
    );
    await swift({ op: "rekey-send" });
    transport.receive.rekey();
    const afterRekey = await swift({ op: "encrypt", payload: hex(plain) });
    phone.socket.send(
      encodeFrame({
        type: FrameType.DATA,
        sessionId,
        peerId: macId,
        payload: unhex(afterRekey.ciphertext!),
      }),
    );
    assert.deepEqual(
      Buffer.from(transport.receive.decrypt((await mac.next(FrameType.DATA)).payload)),
      plain,
    );
    mac.socket.send(
      encodeFrame({
        type: FrameType.DATA,
        sessionId,
        peerId: phoneId,
        payload: transport.send.encrypt(plain),
      }),
    );
    const received = (await phone.next(FrameType.DATA)).payload;
    assert.equal((await swift({ op: "decrypt", message: hex(received) })).payload, hex(plain));
    assert.ok(
      (await swift({ op: "decrypt", message: hex(received) })).error,
      "Swift must refuse replay",
    );
    node.destroy();
    const exited = once(child, "exit");
    child.stdin!.end();
    await exited;
    mac.socket.terminate();
    phone.socket.terminate();
    console.log(
      `${pattern}: CryptoKit ↔ Node through container relay, hashes/identities/SAS, both directions, rekey and replay checks passed.`,
    );
  }
  const logs = compose("logs", "relay");
  assert(!logs.includes("sensitive-noise-fixture"));
  for (const value of credentialValues) assert(!logs.includes(value));
} finally {
  for (const socket of sockets) socket.terminate();
  for (const child of children) if (child.exitCode === null) child.kill();
  if (composeStarted) compose("down", "--rmi", "local", "--volumes");
  await rm(scratch, { recursive: true });
}
