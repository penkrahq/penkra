// FILE: appRawSocket.ts
// Purpose: Provides one bounded request/response TCP exchange for raw-socket Apps.
// Layer: Trusted desktop App runtime

import * as DNS from "node:dns/promises";
import * as Net from "node:net";

const MAX_BYTES = 1024 * 1024;

export interface AppRawSocketRequest {
  host: string;
  port: number;
  payload: Uint8Array;
  responseBytes?: number;
  timeoutMs?: number;
}

export async function exchangeRawSocket(input: AppRawSocketRequest): Promise<Uint8Array> {
  if (
    typeof input.host !== "string" ||
    !/^[a-z0-9.:[\]-]+$/iu.test(input.host) ||
    input.host.length > 253
  )
    throw new Error("Raw socket host is invalid.");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
    throw new Error("Raw socket port is invalid.");
  const payload = Buffer.from(input.payload);
  if (payload.byteLength > MAX_BYTES) throw new Error("Raw socket payload exceeds 1 MiB.");
  const responseBytes = input.responseBytes;
  if (
    responseBytes !== undefined &&
    (!Number.isInteger(responseBytes) || responseBytes < 0 || responseBytes > MAX_BYTES)
  )
    throw new Error("Raw socket responseBytes is invalid.");
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10_000, 1), 30_000);
  const address = Net.isIP(input.host)
    ? input.host
    : (await DNS.lookup(input.host, { verbatim: true })).address;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const socket = Net.createConnection({ host: address, port: input.port });
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(new Uint8Array(Buffer.concat(chunks).subarray(0, responseBytes)));
    };
    socket.setTimeout(timeoutMs, () => settle(new Error("Raw socket exchange timed out.")));
    socket.once("error", (error) => settle(error));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BYTES) return settle(new Error("Raw socket response exceeds 1 MiB."));
      chunks.push(Buffer.from(chunk));
      if (responseBytes !== undefined && size >= responseBytes) settle();
    });
    socket.once("end", () => settle());
    socket.once("connect", () => {
      if (payload.byteLength > 0) socket.write(payload);
      socket.end();
      if (responseBytes === 0) settle();
    });
  });
}
