import type { OperationDeclaration, PenkraAppManifest } from "./manifest";

export const PENKRA_APP_INSTRUCTIONS_MAX_BYTES = 256 * 1024;
export const PENKRA_APP_README_MAX_BYTES = 2 * 1024 * 1024;

export interface GenerateAppHelpInput {
  manifest: PenkraAppManifest;
  instructions: string;
  /** App-local dotted operation key. Omit for App-root help. */
  operation?: string;
}

/** Generates the canonical human/agent CLI help from one immutable App package. */
export function generateAppHelp(input: GenerateAppHelpInput): string {
  const instructions = input.instructions.trim();
  if (!instructions) throw new Error("App instructions must not be empty.");
  if (input.operation !== undefined) {
    const declaration = input.manifest.operations?.find((candidate) => candidate.key === input.operation);
    if (!declaration) throw new Error(`${input.manifest.slug} does not declare operation ${input.operation}.`);
    return operationHelp(input.manifest, instructions, declaration);
  }
  const lines = [
    `${input.manifest.name} (${input.manifest.slug})`,
    input.manifest.summary,
    "",
    "Instructions",
    instructions,
    "",
    "Operations",
  ];
  const operations = input.manifest.operations ?? [];
  if (operations.length === 0) lines.push("This App does not publish agent or CLI operations.");
  for (const operation of operations) {
    lines.push(`  ${commandPath(input.manifest.slug, operation.key)}`);
    lines.push(`    ${operation.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

function operationHelp(
  manifest: PenkraAppManifest,
  instructions: string,
  declaration: OperationDeclaration,
): string {
  return [
    commandPath(manifest.slug, declaration.key),
    declaration.summary,
    "",
    "Usage",
    `  ${commandPath(manifest.slug, declaration.key)} --input '<json>' [--tab-id <tab-id>]`,
    "",
    "App instructions",
    instructions,
    "",
    "Input schema",
    JSON.stringify(declaration.input, null, 2),
    "",
    "Output schema",
    JSON.stringify(declaration.output, null, 2),
    "",
  ].join("\n");
}

function commandPath(slug: string, operation: string): string {
  return `penkra ${slug} ${operation.split(".").join(" ")}`;
}
