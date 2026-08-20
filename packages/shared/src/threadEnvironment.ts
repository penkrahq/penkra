export function resolveThreadWorkspaceCwd(input: {
  projectCwd?: string | null | undefined;
  workingDirectory?: string | null | undefined;
}): string | null {
  return input.workingDirectory ?? input.projectCwd ?? null;
}
