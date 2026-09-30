import { AUTH_SIGNED_OUT_PATH } from "./authSignedOut";
import { recordDiagnosticIncident } from "./webFailureCoverage";

export type AuthLogoutFlowResult = "cancelled" | "failed" | "redirecting";

export async function logoutCurrentBrowserSession(input: {
  readonly confirm: () => Promise<boolean>;
  readonly logout: () => Promise<unknown>;
  readonly navigate: (path: string) => void;
  readonly onError: (error: unknown) => void;
}): Promise<AuthLogoutFlowResult> {
  if (!(await input.confirm())) return "cancelled";
  try {
    await input.logout();
    input.navigate(AUTH_SIGNED_OUT_PATH);
    return "redirecting";
  } catch (error) {
    recordDiagnosticIncident({
      kind: "command.failed",
      code: "APP_OPERATION_FAILED",
      where: "browser.client_runtime",
      severity: "error",
      expected: { accepted: true },
      actual: { accepted: false },
    });
    input.onError(error);
    return "failed";
  }
}
