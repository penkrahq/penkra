import { focusManager, QueryClient } from "@tanstack/react-query";

focusManager.setEventListener((handleFocus) => {
  if (typeof window === "undefined") return;
  const onFocus = () => handleFocus();
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") handleFocus();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
});

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    // Surface failures immediately; the user decides when to retry (operator decision 8).
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}
