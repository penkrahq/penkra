/** Establish crash-recovery evidence before a desktop queue can accept a write. */
export function prepareDesktopDiagnosticsWriter<
  T extends {
    markQueueStartupActive(): void;
    close(): void;
  },
>(createWriter: () => T): T {
  const writer = createWriter();
  try {
    writer.markQueueStartupActive();
    return writer;
  } catch (cause) {
    try {
      writer.close();
    } catch {
      // Preserve the startup marker failure as the reason to abort bootstrap.
    }
    throw cause;
  }
}
