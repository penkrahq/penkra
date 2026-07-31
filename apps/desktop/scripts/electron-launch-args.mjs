export function resolveDevElectronArgs(desktopDir) {
  return ["dist-electron/main.js", `--synara-dev-root=${desktopDir}`];
}
