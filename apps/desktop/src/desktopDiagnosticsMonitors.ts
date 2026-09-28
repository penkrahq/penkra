type MonitorWriter = {
  startHealthSampling(): () => void;
  startProcessWatchdog(): () => void;
};

/** The returned stop function belongs to desktop shutdown, not bootstrap. */
export function startDesktopDiagnosticsMonitors(writer: MonitorWriter): () => void {
  const stopHealth = writer.startHealthSampling();
  const stopWatchdog = writer.startProcessWatchdog();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopHealth();
    stopWatchdog();
  };
}
