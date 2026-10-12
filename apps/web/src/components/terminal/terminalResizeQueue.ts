// Serialize PTY resize requests; completion releases the latest pending dimensions.
export interface TerminalDimensions {
  cols: number;
  rows: number;
}
export interface TerminalResizeState {
  resizeInFlight: boolean;
  lastSentResize: TerminalDimensions | null;
  pendingResize: TerminalDimensions | null;
  disposed: boolean;
}
export type ResolveTerminalResize = () => ((size: TerminalDimensions) => Promise<void>) | null;

function sameSize(left: TerminalDimensions | null, right: TerminalDimensions): boolean {
  return left !== null && left.cols === right.cols && left.rows === right.rows;
}

function drain(state: TerminalResizeState, resolve: ResolveTerminalResize): void {
  if (state.disposed || state.resizeInFlight || state.pendingResize === null) return;
  const send = resolve();
  if (send === null) return;
  const size = state.pendingResize;
  state.pendingResize = null;
  state.lastSentResize = size;
  state.resizeInFlight = true;
  void send(size)
    .catch(() => {
      if (sameSize(state.lastSentResize, size)) state.lastSentResize = null;
    })
    .finally(() => {
      state.resizeInFlight = false;
      drain(state, resolve);
    });
}

export function enqueueTerminalResize(
  state: TerminalResizeState,
  size: TerminalDimensions,
  resolve: ResolveTerminalResize,
): void {
  if (sameSize(state.lastSentResize, size)) {
    state.pendingResize = null;
    return;
  }
  if (sameSize(state.pendingResize, size)) return;
  state.pendingResize = size;
  drain(state, resolve);
}
