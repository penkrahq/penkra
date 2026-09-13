// FILE: appHandlerContract.ts
// Purpose: Prove that host-generated App handler payloads satisfy their operation schemas.
// Layer: Shared App package/runtime validation

import type { AppHandlerDeclaration, PenkraAppManifest } from "@penkra/sdk";
import Ajv2020 from "ajv/dist/2020.js";

export function assertAppHandlerContracts(manifest: PenkraAppManifest): void {
  const ajv = new Ajv2020({ allErrors: false, strict: true, validateFormats: false });
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const operation of manifest.operations ?? []) {
    try {
      validators.set(operation.key, ajv.compile(operation.input));
    } catch (error) {
      throw new Error(`Operation ${operation.key} contains an invalid input schema.`, {
        cause: error,
      });
    }
  }

  for (const [index, handler] of (manifest.contributions?.handlers ?? []).entries()) {
    const validate = validators.get(handler.operation);
    if (!validate) continue;
    const input = handlerInputFixture(handler);
    if (validate(input)) continue;
    const issue = validate.errors?.[0];
    const delivery =
      handler.intent === "open-url"
        ? "a URL"
        : handler.input === "path"
          ? "a path"
          : "a scoped handle";
    throw new Error(
      `Handler contributions.handlers[${index}] (${handler.intent}) delivers ${delivery}, but operation ${handler.operation} rejects that input${issue ? ` at ${issue.instancePath || "$"}: ${issue.message ?? issue.keyword}` : ""}.`,
    );
  }
}

function handlerInputFixture(handler: AppHandlerDeclaration): Record<string, string> {
  if (handler.intent === "open-url") {
    const scheme = handler.schemes[0] ?? "https";
    return { url: `${scheme}://example.com/resource` };
  }
  const kind = handler.intent === "open-file" ? "file" : "directory";
  const name =
    handler.intent === "open-file" ? `document${handler.extensions[0] ?? ".txt"}` : "folder";
  if (handler.input === "path") return { path: `/example/${name}` };
  return {
    handleId: "00000000-0000-4000-8000-000000000000",
    kind,
    name,
  };
}
