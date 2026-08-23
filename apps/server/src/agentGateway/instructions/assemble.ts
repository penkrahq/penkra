import { assembleInstructions, type InstructionOperation } from "@penkra/sdk";

import document from "./INSTRUCTIONS.md?raw";

export interface PenkraInstructionCatalogEntry {
  readonly slug: string;
  readonly summary?: string;
  readonly operations: ReadonlyArray<{ readonly key: string }>;
}

export function assemblePenkraInstructions(input: {
  readonly operations: ReadonlyArray<InstructionOperation>;
  readonly catalog: ReadonlyArray<PenkraInstructionCatalogEntry>;
}): string {
  return assembleInstructions({
    document,
    operations: input.operations,
    catalog: input.catalog.map((app) => ({
      slug: app.slug,
      summary: app.summary ?? "No App summary was provided.",
      operations: app.operations.map((operation) => operation.key),
    })),
  });
}
