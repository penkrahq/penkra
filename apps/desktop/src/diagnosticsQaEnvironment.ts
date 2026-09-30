/** QA proof and fixture credentials must not reach a packaged backend. */
export function stripPackagedDiagnosticsQaEnvironment(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): NodeJS.ProcessEnv {
  if (!packaged) return env;
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("PENKRA_DIAGNOSTICS_QA_")) delete clean[key];
  }
  return clean;
}
