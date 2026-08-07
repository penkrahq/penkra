export function resolveDevElectronArgs(desktopDir) {
  const instance = process.env.PENKRA_DEV_INSTANCE_NUMBER?.trim() || "1";
  return [desktopDir, `--penkra-dev-root=${desktopDir}`, `--penkra-dev-instance=${instance}`];
}
