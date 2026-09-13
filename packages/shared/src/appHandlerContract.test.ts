import type { AppHandlerDeclaration, PenkraAppManifest } from "@penkra/sdk";
import { describe, expect, it } from "vitest";

import { assertAppHandlerContracts } from "./appHandlerContract";

function manifest(
  handler: AppHandlerDeclaration,
  input: Record<string, unknown>,
): PenkraAppManifest {
  return {
    id: "com.example.handler-contract",
    slug: "handler-contract",
    name: "Handler contract",
    summary: "Exercise host handler delivery contracts.",
    version: "1.0.0",
    compatibility: { penkra: ">=0.12.9" },
    icons: [],
    entrypoints: { tab: "app.html", controller: "operations.js" },
    operations: [
      {
        key: "resource.open",
        summary: "Open a resource.",
        input,
        output: { type: "object" },
        examples: [],
        handler: "resource.open",
      },
    ],
    contributions: { handlers: [handler] },
  };
}

const pathSchema = {
  type: "object",
  properties: { path: { type: "string", minLength: 1 } },
  required: ["path"],
  additionalProperties: false,
};

const handleSchema = {
  type: "object",
  properties: {
    handleId: { type: "string", minLength: 1 },
    kind: { enum: ["file", "directory"] },
    name: { type: "string", minLength: 1 },
  },
  required: ["handleId", "kind", "name"],
  additionalProperties: false,
};

describe("assertAppHandlerContracts", () => {
  it.each([
    {
      label: "file path",
      handler: {
        intent: "open-file" as const,
        operation: "resource.open",
        extensions: [".md"],
        input: "path" as const,
      },
      schema: pathSchema,
    },
    {
      label: "directory path",
      handler: {
        intent: "open-directory" as const,
        operation: "resource.open",
        input: "path" as const,
      },
      schema: pathSchema,
    },
    {
      label: "file handle",
      handler: {
        intent: "open-file" as const,
        operation: "resource.open",
        extensions: [".md"],
      },
      schema: handleSchema,
    },
    {
      label: "directory handle",
      handler: { intent: "open-directory" as const, operation: "resource.open" },
      schema: handleSchema,
    },
    {
      label: "URL",
      handler: {
        intent: "open-url" as const,
        operation: "resource.open",
        schemes: ["https"],
      },
      schema: {
        type: "object",
        properties: { url: { type: "string", minLength: 1 } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  ])("accepts the $label delivery contract", ({ handler, schema }) => {
    expect(() => assertAppHandlerContracts(manifest(handler, schema))).not.toThrow();
  });

  it.each([
    {
      label: "path operation with default handle delivery",
      handler: {
        intent: "open-file" as const,
        operation: "resource.open",
        extensions: [".md"],
      },
      schema: pathSchema,
      delivery: "a scoped handle",
    },
    {
      label: "handle operation with explicit path delivery",
      handler: {
        intent: "open-directory" as const,
        operation: "resource.open",
        input: "path" as const,
      },
      schema: handleSchema,
      delivery: "a path",
    },
  ])("rejects a $label", ({ handler, schema, delivery }) => {
    expect(() => assertAppHandlerContracts(manifest(handler, schema))).toThrow(
      `delivers ${delivery}, but operation resource.open rejects that input`,
    );
  });
});
