// FILE: localModelCatalog.ts
// Purpose: Curated on-device models for the Local provider, and whether this Mac can run each.
// Picks come from benchmarks/local-models/FINDINGS.md. Newest generation only.

export interface LocalModelEntry {
  readonly id: string;
  readonly label: string;
  /** Hugging Face repo with MLX weights, pinned to a revision. */
  readonly repo: string;
  readonly revision: string;
  readonly downloadGb: number;
  /** Total system memory needed to run at the context cap without swapping. */
  readonly minMemoryGb: number;
  /** Max prompt tokens sent; keeps prefill under the macOS GPU watchdog. */
  readonly contextTokens: number;
  /** A larger cap for Macs with this much memory, where the model has been tested at it. */
  readonly largeMemory?: { readonly minMemoryGb: number; readonly contextTokens: number };
  readonly maxOutputTokens: number;
  /** Thinking past this many characters is cut off and the turn answered directly. */
  readonly thinkingBudgetChars: number;
  readonly note: string;
}

export const LOCAL_MODEL_CATALOG: readonly LocalModelEntry[] = [
  {
    id: "qwen3.5-4b",
    label: "Qwen3.5 4B",
    repo: "mlx-community/Qwen3.5-4B-MLX-4bit",
    revision: "main",
    downloadGb: 3,
    minMemoryGb: 8,
    contextTokens: 32_768,
    maxOutputTokens: 16_384,
    thinkingBudgetChars: 4_000,
    note: "Fastest. Good for small edits and questions.",
  },
  {
    id: "qwen3.5-9b",
    label: "Qwen3.5 9B",
    repo: "mlx-community/Qwen3.5-9B-4bit",
    revision: "main",
    downloadGb: 5.5,
    minMemoryGb: 16,
    contextTokens: 65_536,
    maxOutputTokens: 16_384,
    thinkingBudgetChars: 8_000,
    note: "Best balance of speed and quality.",
  },
  {
    id: "ornith-1.5-9b",
    label: "Ornith 1.5 9B",
    repo: "ornith-ai/Ornith-1.5-9B-MLX-4bit",
    revision: "main",
    downloadGb: 5.1,
    minMemoryGb: 16,
    contextTokens: 65_536,
    maxOutputTokens: 16_384,
    thinkingBudgetChars: 8_000,
    note: "Tuned for coding agents. Slower than Qwen3.5 9B.",
  },
  {
    id: "ornith-1.5-35b-a3b",
    label: "Ornith 1.5 35B",
    repo: "ornith-ai/Ornith-1.5-35B-A3B-MLX-4bit",
    revision: "main",
    downloadGb: 19.5,
    minMemoryGb: 32,
    contextTokens: 65_536,
    // Read 112k tokens correctly in 11 min at 31 GB peak (FINDINGS.md).
    largeMemory: { minMemoryGb: 48, contextTokens: 131_072 },
    maxOutputTokens: 16_384,
    thinkingBudgetChars: 12_000,
    note: "Strongest. Large download.",
  },
];

export type LocalModelAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "insufficient-memory"; readonly reason: string };

export function localModelAvailability(
  entry: LocalModelEntry,
  totalMemoryBytes: number,
): LocalModelAvailability {
  // Macs report slightly under their marketed size (e.g. 15.9 GB for 16 GB).
  const machineGb = Math.round(totalMemoryBytes / 1024 ** 3);
  if (machineGb >= entry.minMemoryGb) return { kind: "available" };
  return {
    kind: "insufficient-memory",
    reason: `Needs ${entry.minMemoryGb} GB memory — this Mac has ${machineGb} GB`,
  };
}

/** The entry as it applies to this Mac: the larger context cap when it has the memory for it. */
export function localModelForMachine(entry: LocalModelEntry, totalMemoryBytes: number): LocalModelEntry {
  const machineGb = Math.round(totalMemoryBytes / 1024 ** 3);
  return entry.largeMemory && machineGb >= entry.largeMemory.minMemoryGb
    ? { ...entry, contextTokens: entry.largeMemory.contextTokens }
    : entry;
}

export function findLocalModel(id: string): LocalModelEntry | null {
  return LOCAL_MODEL_CATALOG.find((entry) => entry.id === id) ?? null;
}
