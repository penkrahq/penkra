export interface LinkedThreadTarget {
  id: string;
  folderId: string;
  spaceId?: string | null;
  archivedAt?: string | null;
}

export interface LinkedThreadFolder {
  id: string;
  spaceId: string;
}

export function requireLinkedThreadTarget(input: {
  target: LinkedThreadTarget | undefined;
  folders: ReadonlyArray<LinkedThreadFolder>;
  spaceId: string;
}): LinkedThreadTarget {
  const { target } = input;
  if (!target || target.archivedAt) {
    throw Object.assign(new Error("The linked Thread is unavailable."), {
      code: "THREAD_NOT_FOUND",
    });
  }
  const targetSpaceId =
    target.spaceId ?? input.folders.find((folder) => folder.id === target.folderId)?.spaceId;
  if (targetSpaceId !== input.spaceId) {
    throw Object.assign(new Error("The linked Thread is outside the current Space."), {
      code: "THREAD_ACCESS_DENIED",
    });
  }
  return target;
}

export function composerConflictCode(state: {
  composer: { empty: boolean };
  phase: string;
  queued: { count: number };
  pendingQuestion: boolean;
}): string | null {
  if (state.pendingQuestion) return "THREAD_WAITING_FOR_USER";
  if (state.queued.count > 0) return "THREAD_HAS_QUEUED_COMPOSITION";
  if (!state.composer.empty) return "COMPOSER_NOT_EMPTY";
  return null;
}

export async function openLinkedThreadAndCompose<C, T>(input: {
  target: LinkedThreadTarget;
  composition?: C;
  navigate: (threadId: string) => Promise<void>;
  targetAvailable: (threadId: string) => boolean;
  waitForMount: (threadId: string) => Promise<void>;
  compose: (threadId: string, composition: C) => Promise<T>;
}): Promise<{ threadId: string; composition: T | null }> {
  try {
    await input.navigate(input.target.id);
  } catch (cause) {
    throw Object.assign(new Error("Penkra could not open the linked Thread.", { cause }), {
      code: "THREAD_NAVIGATION_FAILED",
    });
  }
  if (!input.targetAvailable(input.target.id)) {
    throw Object.assign(new Error("The linked Thread is unavailable."), {
      code: "THREAD_NOT_FOUND",
    });
  }
  await input.waitForMount(input.target.id);
  if (!input.composition) return { threadId: input.target.id, composition: null };
  const composition = await input.compose(input.target.id, input.composition);
  return { threadId: input.target.id, composition };
}
