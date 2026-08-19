// FILE: appTestHostPhases.ts
// Purpose: Gives every isolated App-test host phase a main-process wall-clock deadline.
// Layer: Trusted desktop developer harness

export const APP_TEST_PHASE_TIMEOUT_MS = 10_000;

export async function withAppTestPhaseTimeout<T>(input: {
  phase: string;
  run: () => Promise<T> | T;
  timeoutMs?: number;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? APP_TEST_PHASE_TIMEOUT_MS;
  if (!input.phase.trim()) throw new Error("App test phase name is required.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("App test phase timeout must be a positive finite number.");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`App integration phase "${input.phase}" exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(input.run), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
