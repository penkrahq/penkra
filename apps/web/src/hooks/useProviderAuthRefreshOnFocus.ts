// FILE: useProviderAuthRefreshOnFocus.ts
// Purpose: Re-probe provider auth status when the window regains focus/visibility,
//   so account changes made outside the app (e.g. `claude login` / logout / adding
//   an account in a terminal) reflect without restarting the app.
// Layer: Web UI hooks
// Exports: useProviderAuthRefreshOnFocus

import { useProviderStatusRefresh } from "./useProviderStatusRefresh";

export function useProviderAuthRefreshOnFocus(): void {
  useProviderStatusRefresh({
    refreshOnFocus: true,
  });
}
