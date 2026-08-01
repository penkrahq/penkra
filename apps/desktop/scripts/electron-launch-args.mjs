export function resolveDevElectronArgs(desktopDir) {
  return ["dist-electron/main.js", `--penkra-dev-root=${desktopDir}`];
}
