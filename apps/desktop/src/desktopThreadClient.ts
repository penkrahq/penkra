// FILE: desktopThreadClient.ts
// Purpose: Call the private backend Thread command executor without a shell window.

import type { DesktopThreadApiRequest } from "@penkra/contracts";

export async function executeDesktopThreadCommand(input: {
  url: string;
  token: string;
  request: DesktopThreadApiRequest;
  fetcher?: typeof fetch;
}): Promise<unknown> {
  const response = await (input.fetcher ?? fetch)(`${input.url}/api/desktop/thread-command`, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input.request),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    ok?: unknown;
    result?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (body.ok === true) return body.result;
  throw Object.assign(
    new Error(typeof body.message === "string" ? body.message : "Thread command failed."),
    {
      code: typeof body.code === "string" ? body.code : "THREAD_COMMAND_FAILED",
    },
  );
}
