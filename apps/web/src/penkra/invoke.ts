import {
  ProviderKind,
  type PenkraTodoSummary,
  type ProviderKind as ProviderKindType,
} from "@penkra/contracts";
import { Schema } from "effect";

export function penkraProjectId(clientId: string): string {
  return `penkra-client-${clientId}`;
}

export function resolvePenkraTodoProvider(todo: PenkraTodoSummary): ProviderKindType | undefined {
  const candidate = todo.provider ?? todo.defaultProvider;
  return candidate && Schema.is(ProviderKind)(candidate) ? candidate : undefined;
}

export function composePenkraTodoPrompt(todo: PenkraTodoSummary): string {
  const skillLine = todo.skillRef
    ? `Kind: ${todo.kind}  (skill: $${todo.skillRef})`
    : `Kind: ${todo.kind}`;
  const instructions =
    typeof todo.payload.instructions === "string" && todo.payload.instructions.trim()
      ? `Instructions: ${todo.payload.instructions.trim()}`
      : null;
  const program =
    todo.programId && todo.programLabel
      ? `Program: ${todo.programLabel} (id ${todo.programId}) - read its state before starting.`
      : null;
  const ending = todo.skillRef
    ? `Load $${todo.skillRef} and follow it. Mark the todo done when complete (\`penkra todo done ${todo.id}\`), or blocked with a reason if you cannot proceed.`
    : `Mark the todo done when complete (\`penkra todo done ${todo.id}\`), or blocked with a reason if you cannot proceed.`;

  return [
    "Work this Penkra todo.",
    "",
    `Todo: ${todo.title}`,
    `Id: ${todo.id}`,
    skillLine,
    `Due: ${todo.dueAt ?? "no date"}`,
    instructions,
    program,
    "",
    ending,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
