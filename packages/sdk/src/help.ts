import type { OperationDeclaration, PenkraAppManifest } from "./manifest";

export const PENKRA_APP_INSTRUCTIONS_MAX_BYTES = 256 * 1024;
export const PENKRA_APP_README_MAX_BYTES = 2 * 1024 * 1024;

export interface GenerateAppHelpInput {
  manifest: PenkraAppManifest;
  instructions: string;
  /** App-local dotted operation key. Omit for App-root help. */
  operation?: string;
}

export interface InstructionOperation {
  readonly command: string;
  readonly summary?: string;
}

export interface InstructionCatalogApp {
  readonly slug: string;
  readonly summary: string;
  readonly operations: ReadonlyArray<string>;
}

/** Assemble one instruction document with declarations rendered as data. */
export function assembleInstructions(input: {
  readonly document: string;
  readonly operations: ReadonlyArray<InstructionOperation>;
  readonly catalog?: ReadonlyArray<InstructionCatalogApp>;
}): string {
  const document = input.document.trim();
  if (!document) throw new Error("Instructions must not be empty.");
  const lines = [document];
  if (input.catalog !== undefined) {
    lines.push("", "## What is installed right now", "");
    if (input.catalog.length === 0) {
      lines.push("No Apps are enabled in this Space.");
    } else {
      for (const app of input.catalog) {
        lines.push(`### ${app.slug}`, "", app.summary);
        lines.push(
          app.operations.length > 0
            ? `Operations: ${app.operations.map((operation) => `\`${operation}\``).join(" · ")}`
            : "This App declares no operations.",
        );
      }
    }
  }
  lines.push("", "## Operations", "");
  if (input.operations.length === 0) lines.push("No operations are declared.");
  for (const operation of input.operations) {
    lines.push(`- \`${operation.command}\`${operation.summary ? ` — ${operation.summary}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Generates canonical agent-gateway help from one immutable App package. */
export function generateAppHelp(input: GenerateAppHelpInput): string {
  const instructions = input.instructions.trim();
  if (!instructions) throw new Error("App instructions must not be empty.");
  if (input.operation !== undefined) {
    const declaration = input.manifest.operations?.find(
      (candidate) => candidate.key === input.operation,
    );
    if (!declaration)
      throw new Error(`${input.manifest.slug} does not declare operation ${input.operation}.`);
    return operationHelp(input.manifest, declaration);
  }
  const header = [
    `${input.manifest.name} (${input.manifest.slug})`,
    input.manifest.summary,
    "",
    "Instructions",
    instructions,
  ].join("\n");
  const operations = input.manifest.operations ?? [];
  return assembleInstructions({
    document: header,
    operations: operations.map((operation) => ({
      command: commandPath(input.manifest.slug, operation.key),
      summary: operation.summary,
    })),
  });
}

function operationHelp(manifest: PenkraAppManifest, declaration: OperationDeclaration): string {
  const lines = [
    commandPath(manifest.slug, declaration.key),
    declaration.summary,
    "",
    "Usage",
    `  ${commandPath(manifest.slug, declaration.key)} [--input '<json>'] [--<property> <value> ...] [--tab-id <tab-id>]`,
    "",
    "Operation input",
    ...operationFlagHelp(declaration.input),
    "",
    "Invocation",
    "  --tab-id <tab-id>  Target one existing App tab (invocation envelope; not App input).",
    "  --input <json>      Supply the complete input object as JSON.",
    "",
    "App guidance",
    `  Run ${manifest.slug} --help for ${manifest.name} operating instructions.`,
    "",
    "Declared permissions",
    ...(manifest.permissions?.length
      ? manifest.permissions.map(
          (permission) =>
            `  ${permission.name} (${permission.required ? "required" : "optional"})${permission.audience ? ` for ${permission.audience}` : ""} — ${permission.reason}`,
        )
      : ["  None."]),
    "",
    "Validated input schema",
    JSON.stringify(declaration.input, null, 2),
    "",
    "Validated output schema",
    JSON.stringify(declaration.output, null, 2),
  ];
  lines.push("");
  return lines.join("\n");
}

function operationFlagHelp(schema: Readonly<Record<string, unknown>>): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const names = Object.keys(properties).sort(
    (left, right) =>
      Number(required.has(right)) - Number(required.has(left)) || left.localeCompare(right),
  );
  if (names.length === 0) return ["  This operation has no named input properties."];
  return names.map((name) => {
    const property = isRecord(properties[name]) ? properties[name] : {};
    const type = Array.isArray(property.type)
      ? property.type.filter((value) => typeof value === "string").join("|")
      : typeof property.type === "string"
        ? property.type
        : "json";
    const details = [
      required.has(name) ? "required" : "optional",
      ...(property.default === undefined ? [] : [`default ${JSON.stringify(property.default)}`]),
      ...(Array.isArray(property.enum)
        ? [`one of ${property.enum.map((value) => JSON.stringify(value)).join(", ")}`]
        : []),
    ];
    return `  --${camelToKebab(name)} <${type}>  ${details.join("; ")}.`;
  });
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandPath(slug: string, operation: string): string {
  return `${slug} ${operation.split(".").join(" ")}`;
}
