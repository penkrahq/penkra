export const PENKRA_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;
export const PENKRA_OPERATION_SCHEMA_MAX_BYTES = 64 * 1024;
export const PENKRA_OPERATION_SCHEMA_MAX_DEPTH = 32;
export const PENKRA_OPERATION_SCHEMA_MAX_NODES = 4_096;

const UNSUPPORTED_KEYWORDS = new Set(["$id", "$dynamicRef", "$dynamicAnchor", "pattern", "patternProperties"]);

/**
 * Applies Penkra's bounded JSON Schema 2020-12 profile.
 *
 * Schemas are package content rather than host code. The profile disallows
 * remote/dynamic resolution and regular-expression evaluation, and bounds
 * size and structure before the trusted host compiles a schema.
 */
export function validatePenkraJsonSchema(schema: Readonly<Record<string, unknown>>): string[] {
  const issues: string[] = [];
  let encoded: string;
  try {
    encoded = JSON.stringify(schema);
  } catch {
    return ["must be JSON-serializable"];
  }
  if (new TextEncoder().encode(encoded).byteLength > PENKRA_OPERATION_SCHEMA_MAX_BYTES) {
    issues.push(`must not exceed ${PENKRA_OPERATION_SCHEMA_MAX_BYTES} UTF-8 bytes`);
  }

  const seen = new Set<unknown>();
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > PENKRA_OPERATION_SCHEMA_MAX_NODES) return;
    if (depth > PENKRA_OPERATION_SCHEMA_MAX_DEPTH) {
      issues.push(`${path} exceeds the maximum schema depth`);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) {
      issues.push(`${path} contains a circular reference`);
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
    } else {
      for (const [key, entry] of Object.entries(value)) {
        const entryPath = `${path}.${key}`;
        if (UNSUPPORTED_KEYWORDS.has(key)) {
          issues.push(`${entryPath} is not supported by the Penkra schema profile`);
        }
        if (key === "$schema" && (path !== "$" || entry !== PENKRA_JSON_SCHEMA_DIALECT)) {
          issues.push(`${entryPath} must identify ${PENKRA_JSON_SCHEMA_DIALECT} at the schema root`);
        }
        if (key === "$ref" && (typeof entry !== "string" || !entry.startsWith("#"))) {
          issues.push(`${entryPath} must be a document-local fragment reference`);
        }
        visit(entry, entryPath, depth + 1);
      }
    }
    seen.delete(value);
  };
  visit(schema, "$", 0);
  if (nodes > PENKRA_OPERATION_SCHEMA_MAX_NODES) {
    issues.push(`must not exceed ${PENKRA_OPERATION_SCHEMA_MAX_NODES} schema nodes`);
  }
  return [...new Set(issues)];
}
