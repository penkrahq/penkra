// FILE: appTestHostHandshake.ts
// Purpose: Distinguishes a completed App test handshake from its bounded timeout path.
// Layer: Trusted desktop developer harness

export async function resolveAppTestHandshake(
  run: () => Promise<void>,
): Promise<"ready" | "timed-out"> {
  try {
    await run();
    return "ready";
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('phase "runtime-handshake"')) {
      throw error;
    }
    return "timed-out";
  }
}
