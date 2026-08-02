export function routeFromHash(hash) {
  return hash === "#focus" ? "focus" : hash === "#settings" ? "settings" : "home";
}
export function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}
