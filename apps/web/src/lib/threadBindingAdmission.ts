// FILE: threadBindingAdmission.ts
// Purpose: Resolves the exact provider-binding revision immediately before turn admission.
// Layer: Web orchestration admission helper

const THREAD_BINDING_LOAD_ERROR = "Could not load the thread's current provider binding.";

export async function resolveThreadBindingRevisionAtAdmission(input: {
  readonly hasThreadStarted: boolean;
  readonly cachedRevision?: number;
  readonly loadCurrentRevision: () => Promise<number | undefined>;
}): Promise<number> {
  if (!input.hasThreadStarted) {
    return 0;
  }
  if (input.cachedRevision !== undefined) {
    return input.cachedRevision;
  }

  const revision = await input.loadCurrentRevision();
  if (revision === undefined) {
    throw new Error(THREAD_BINDING_LOAD_ERROR);
  }
  return revision;
}
