// FILE: appOperationSchema.ts
// Purpose: Compiles bounded App operation schemas and validates invocation data.
// Layer: Trusted desktop App operation boundary

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

import {
  validatePenkraJsonSchema,
  type OperationDeclaration,
  type PenkraAppManifest,
} from "@penkra/sdk";

export const APP_OPERATION_VALUE_MAX_BYTES = 1024 * 1024;
export const APP_OPERATION_VALUE_MAX_DEPTH = 64;
export const APP_OPERATION_VALUE_MAX_NODES = 100_000;

export interface AppOperationValidators {
  input: ValidateFunction;
  output: ValidateFunction;
}

export function compileOperationValidators(declaration: OperationDeclaration): AppOperationValidators {
  const ajv = new Ajv2020({
    allErrors: false,
    strict: true,
    validateFormats: false,
  });
  assertSchemaProfile(declaration.input, `${declaration.key} input`);
  assertSchemaProfile(declaration.output, `${declaration.key} output`);
  try {
    return {
      input: ajv.compile(declaration.input),
      output: ajv.compile(declaration.output),
    };
  } catch (error) {
    throw new Error(`Operation ${declaration.key} contains an invalid JSON Schema.`, { cause: error });
  }
}

export function assertOperationSchemas(manifest: PenkraAppManifest): void {
  for (const declaration of manifest.operations ?? []) compileOperationValidators(declaration);
}

export function assertOperationValue(
  value: unknown,
  validator: ValidateFunction,
  label: "input" | "output",
): void {
  assertBoundedJsonValue(value, label);
  if (validator(value)) return;
  throw new Error(`Operation ${label} does not match its declared schema${formatAjvError(validator.errors?.[0])}.`);
}

function assertSchemaProfile(schema: Readonly<Record<string, unknown>>, label: string): void {
  const issues = validatePenkraJsonSchema(schema);
  if (issues.length > 0) throw new Error(`Operation ${label} schema is unsupported: ${issues.join("; ")}.`);
}

function assertBoundedJsonValue(value: unknown, label: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > APP_OPERATION_VALUE_MAX_NODES) {
      throw new Error(`Operation ${label} exceeds the maximum JSON node count.`);
    }
    if (current.depth > APP_OPERATION_VALUE_MAX_DEPTH) {
      throw new Error(`Operation ${label} exceeds the maximum JSON depth.`);
    }
    const candidate = current.value;
    if (
      candidate === null || typeof candidate === "string" || typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      continue;
    }
    if (typeof candidate !== "object") throw new Error(`Operation ${label} must be JSON data.`);
    if (seen.has(candidate)) throw new Error(`Operation ${label} must not contain circular references.`);
    seen.add(candidate);
    const entries = Array.isArray(candidate) ? candidate : Object.values(candidate);
    for (const entry of entries) stack.push({ value: entry, depth: current.depth + 1 });
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(`Operation ${label} must be JSON-serializable.`, { cause: error });
  }
  if (Buffer.byteLength(encoded, "utf8") > APP_OPERATION_VALUE_MAX_BYTES) {
    throw new Error(`Operation ${label} exceeds the maximum JSON byte size.`);
  }
}

function formatAjvError(error: ErrorObject | undefined): string {
  if (!error) return "";
  return ` at ${error.instancePath || "$"}: ${error.message ?? error.keyword}`;
}
