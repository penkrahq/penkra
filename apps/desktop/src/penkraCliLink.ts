import * as FS from "node:fs";
import * as Path from "node:path";

export type PenkraCliInstallResult = {
  readonly status: "installed" | "not-bundled";
  readonly localPath: string | null;
  readonly globalLink: "linked" | "current" | "conflict" | "unavailable" | "not-applicable";
};

export async function installBundledPenkraCli(input: {
  readonly resourcesPath: string;
  readonly penkraRoot: string;
  readonly platform: NodeJS.Platform;
  readonly globalBinDirectory?: string;
}): Promise<PenkraCliInstallResult> {
  const executableName = input.platform === "win32" ? "penkra.exe" : "penkra";
  const sourcePath = Path.join(input.resourcesPath, "penkra-cli", executableName);
  if (!FS.existsSync(sourcePath)) {
    return { status: "not-bundled", localPath: null, globalLink: "not-applicable" };
  }

  const localDirectory = Path.join(input.penkraRoot, ".penkra", "bin");
  const localPath = Path.join(localDirectory, executableName);
  const temporaryLocalPath = Path.join(
    localDirectory,
    `.${executableName}.${process.pid}.${Date.now()}.tmp`,
  );
  await FS.promises.mkdir(localDirectory, { recursive: true, mode: 0o700 });
  try {
    await FS.promises.copyFile(sourcePath, temporaryLocalPath, FS.constants.COPYFILE_EXCL);
    if (input.platform !== "win32") await FS.promises.chmod(temporaryLocalPath, 0o755);
    await FS.promises.rename(temporaryLocalPath, localPath);
  } finally {
    await FS.promises.rm(temporaryLocalPath, { force: true }).catch(() => undefined);
  }

  if (input.platform === "win32") {
    return { status: "installed", localPath, globalLink: "not-applicable" };
  }

  const globalBinDirectory = input.globalBinDirectory ?? "/usr/local/bin";
  const globalPath = Path.join(globalBinDirectory, "penkra");
  const temporaryGlobalPath = Path.join(
    globalBinDirectory,
    `.penkra.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await FS.promises.mkdir(globalBinDirectory, { recursive: true });
    const existing = await FS.promises.lstat(globalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && !existing.isSymbolicLink()) {
      return { status: "installed", localPath, globalLink: "conflict" };
    }
    if (existing?.isSymbolicLink()) {
      const currentTarget = await FS.promises.readlink(globalPath);
      if (Path.resolve(globalBinDirectory, currentTarget) === localPath) {
        return { status: "installed", localPath, globalLink: "current" };
      }
    }
    await FS.promises.symlink(localPath, temporaryGlobalPath);
    await FS.promises.rename(temporaryGlobalPath, globalPath);
    return { status: "installed", localPath, globalLink: "linked" };
  } catch {
    return { status: "installed", localPath, globalLink: "unavailable" };
  } finally {
    await FS.promises.rm(temporaryGlobalPath, { force: true }).catch(() => undefined);
  }
}
