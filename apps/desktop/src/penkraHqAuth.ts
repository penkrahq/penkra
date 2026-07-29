import { constants } from "node:fs";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

import type { DesktopHqAuthResult } from "@synara/contracts";

export async function authenticateAndStorePenkraHq(input: {
  endpoint: string;
  password: string;
  configPath: string;
  fetchImpl?: typeof fetch;
}): Promise<DesktopHqAuthResult> {
  if (input.password.length < 1 || input.password.length > 1024) {
    return { ok: false, message: "Enter the Penkra master password." };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.endpoint.replace(/\/$/, "")}/auth/hq`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password: input.password }),
    });
  } catch {
    return {
      ok: false,
      message: "Penkra could not reach the API. Check the connection and try again.",
    };
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || !isIssuedHqToken(payload)) {
    return { ok: false, message: "Authentication failed." };
  }
  await writeAtomicSecret(
    input.configPath,
    `${JSON.stringify({ endpoint: input.endpoint.replace(/\/$/, ""), scope: "hq", token: payload.token }, null, 2)}\n`,
  );
  return { ok: true };
}

async function writeAtomicSecret(filePath: string, contents: string): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const file = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
  const directory = await open(directoryPath, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isIssuedHqToken(value: unknown): value is { token: string; scope: "hq" } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.scope === "hq" &&
    typeof record.token === "string" &&
    /^pk_hq_[A-Za-z0-9]+$/.test(record.token)
  );
}
