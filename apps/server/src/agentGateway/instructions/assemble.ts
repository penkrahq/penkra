import { assembleInstructions, type InstructionOperation } from "@penkra/sdk";

import document from "./SERVER.md?raw";

export function assemblePenkraInstructions(input: {
  readonly operations: ReadonlyArray<InstructionOperation>;
}): string {
  return assembleInstructions({
    document,
    operations: input.operations,
  });
}
