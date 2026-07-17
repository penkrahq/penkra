import { existsSync } from "node:fs";
import path from "node:path";

export function withPenkraProviderEnv(
  env: NodeJS.ProcessEnv,
  input: { workspace?: string | undefined; threadId: string },
): NodeJS.ProcessEnv {
  const workspaceConfig = input.workspace
    ? path.join(input.workspace, ".penkra", "config.json")
    : undefined;
  const configPath = workspaceConfig && existsSync(workspaceConfig) ? workspaceConfig : undefined;
  const {
    PENKRA_CONFIG: _inheritedConfig,
    PENKRA_ENDPOINT: _inheritedEndpoint,
    PENKRA_SESSION_ID: _inheritedSessionId,
    PENKRA_TOKEN: _inheritedToken,
    ...providerEnv
  } = env;
  return {
    ...providerEnv,
    ...(configPath ? { PENKRA_CONFIG: configPath } : {}),
    PENKRA_SESSION_ID: input.threadId,
  };
}
