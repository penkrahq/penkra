export interface RecoverableCreationPlanEntry {
  readonly ids: {
    readonly threadId: string;
    readonly compensateCommandId: string;
  };
}

function parsePlanArray(planJson: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(planJson);
  if (!Array.isArray(parsed)) {
    throw new Error("Stored gateway creation plan is not an array.");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Stored gateway creation plan entry ${index} is invalid.`);
    }
    return entry as Record<string, unknown>;
  });
}

export function parseRecoverableCreationPlan(
  planJson: string,
  _operationId: string,
): ReadonlyArray<RecoverableCreationPlanEntry> {
  return parsePlanArray(planJson).map((value, index) => {
    const ids = value.ids;
    if (!ids || typeof ids !== "object") {
      throw new Error(`Stored gateway creation plan entry ${index} has no deterministic ids.`);
    }
    const record = ids as Record<string, unknown>;
    if (typeof record.threadId !== "string" || typeof record.compensateCommandId !== "string") {
      throw new Error(`Stored gateway creation plan entry ${index} is incomplete.`);
    }
    return {
      ids: {
        threadId: record.threadId,
        compensateCommandId: record.compensateCommandId,
      },
    };
  });
}

export function redactCreationPlanForPurgedCaller(input: {
  readonly planJson: string;
  readonly operationId: string;
}): string {
  return JSON.stringify(parseRecoverableCreationPlan(input.planJson, input.operationId));
}
