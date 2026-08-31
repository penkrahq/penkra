import type { OperationDeclaration, PenkraAppManifest } from "./manifest";

export const PENKRA_APP_INSTRUCTIONS_MAX_BYTES = 256 * 1024;
export const PENKRA_APP_README_MAX_BYTES = 2 * 1024 * 1024;

export interface GenerateAppHelpInput {
  manifest: PenkraAppManifest;
  instructions: string;
  /** App-local dotted operation key. Omit for App-root help. */
  operation?: string;
  /** Resolved contents of the selected operation's instructionsPath. */
  operationInstructions?: string;
}

export interface InstructionOperation {
  readonly command: string;
  readonly summary?: string;
}

export interface OperationHelpExample {
  readonly name: string;
  readonly command: string;
}

export interface GenerateOperationHelpInput {
  readonly command: string;
  readonly summary: string;
  readonly instructions?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly examples: ReadonlyArray<OperationHelpExample>;
  readonly parentHelp?: string;
  readonly permissions?: ReadonlyArray<string>;
}

/** Assemble one instruction document with declarations rendered as data. */
export function assembleInstructions(input: {
  readonly document: string;
  readonly operations: ReadonlyArray<InstructionOperation>;
}): string {
  const document = input.document.trim();
  if (!document) throw new Error("Instructions must not be empty.");
  const lines = [document];
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
    return operationHelp(input.manifest, declaration, input.operationInstructions);
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

function operationHelp(
  manifest: PenkraAppManifest,
  declaration: OperationDeclaration,
  resolvedInstructions?: string,
): string {
  const instructions = resolvedInstructions ?? declaration.instructions;
  return generateOperationHelp({
    command: commandPath(manifest.slug, declaration.key),
    summary: declaration.summary,
    ...(instructions === undefined ? {} : { instructions }),
    input: declaration.input,
    output: declaration.output,
    examples: (declaration.examples ?? []).map((example) => ({
      name: example.name,
      command: commandExample(manifest.slug, declaration.key, example.input),
    })),
    parentHelp: `Run ${manifest.slug} --help for ${manifest.name} operating instructions.`,
    permissions: manifest.permissions?.length
      ? manifest.permissions.map(
          (permission) =>
            `${permission.name} (${permission.required ? "required" : "optional"})${permission.audience ? ` for ${permission.audience}` : ""} — ${permission.reason}`,
        )
      : [],
  });
}

/** Generate the canonical leaf-help document for a Penkra or App operation. */
export function generateOperationHelp(input: GenerateOperationHelpInput): string {
  const lines = [
    input.command,
    input.summary,
    ...(input.instructions
      ? ["", "How to use this operation", "", ...input.instructions.trim().split("\n")]
      : []),
    "",
    "Examples",
    ...input.examples.flatMap((example) =>
      ["", `  ${example.name}`, ""].concat(
        JSON.stringify({ command: example.command }, null, 2)
          .split("\n")
          .map((line) => `  ${line}`),
      ),
    ),
    "",
    "Input fields",
    ...operationFlagHelp(input.input),
    "",
    "Invocation",
    "  Send one ordinary command string. Use --name value for scalar fields and",
    '  --input "{...}" for a complete JSON value.',
    "  --input   Complete JSON operation input validated against the schema below.",
    ...(input.parentHelp ? ["", "Operating manual", `  ${input.parentHelp}`] : []),
    ...(input.permissions
      ? [
          "",
          "Declared permissions",
          ...(input.permissions.length
            ? input.permissions.map((line) => `  ${line}`)
            : ["  None."]),
        ]
      : []),
    "",
    "Validated input schema",
    JSON.stringify(input.input, null, 2),
    ...(input.output ? ["", "Validated output schema", JSON.stringify(input.output, null, 2)] : []),
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
  const names = Object.keys(properties).toSorted(
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
    const description = typeof property.description === "string" ? ` ${property.description}` : "";
    return `  ${name} <${type}>  ${details.join("; ")}.${description}`;
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function commandPath(slug: string, operation: string): string {
  return `${slug} ${operation.split(".").join(" ")}`;
}

function commandExample(slug: string, operation: string, input: unknown): string {
  const json = JSON.stringify(input).replaceAll("'", "\\u0027");
  return `${commandPath(slug, operation)} --input '${json}'`;
}
