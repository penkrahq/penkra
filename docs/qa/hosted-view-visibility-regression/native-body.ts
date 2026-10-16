const os: any[] = [];
let targetId: number | null = null;
function geometry() {
  const helper = JSON.parse(fs.readFileSync(path.join(root, "helper-state.json"), "utf8"));
  const out = spawnSync(
    "python3",
    ["qa/cg-window-list.py", String(process.pid), String(helper.pid)],
    { encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(out.stderr);
  const d = JSON.parse(out.stdout);
  if (targetId === null)
    targetId =
      d.windows.find(
        (w: any) =>
          w.pid === process.pid &&
          w.bounds.X === 70 &&
          w.bounds.Y === 70 &&
          w.bounds.Width === 1000 &&
          w.bounds.Height === 700,
      )?.windowId ?? null;
  return {
    ...d,
    targetWindow: d.windows.find((w: any) => w.windowId === targetId) ?? null,
    helper,
  };
}
async function sample() {
  return { ...(await state()), shellFullScreen: shell.isFullScreen(), geometry: geometry() };
}
async function record(name: string, count = 5) {
  caseId = name;
  trace("samples-started", { name });
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(await sample());
    await pause(200);
  }
  const v = { caseId: name, samples };
  os.push(v);
  fs.writeFileSync(path.join(evidence, "native-results.json"), JSON.stringify(os, null, 2));
  trace("samples-finished", { name });
  return v;
}
async function helper(action: string, extra: any = {}) {
  fs.writeFileSync(
    path.join(root, "helper-control.json"),
    JSON.stringify({ action, serial: Date.now(), ...extra }),
  );
  await pause(400);
}
async function reset() {
  caseId = "reset";
  await helper("hide");
  app.show();
  shell.restore();
  shell.show();
  shell.setBounds({ x: 70, y: 70, width: 1000, height: 700 });
  app.focus({ steal: true });
  shell.moveTop();
  shell.focus();
  await host.setWindowVisibility(owner, true);
  await host.presentInWindow({
    tabId: "qa-A",
    deckId: "qa-folder",
    folderId: "qa-folder",
    threadId: "qa-thread",
    windowId: owner,
    bounds: { x: 601, y: 44, width: 399, height: 656 },
  } as any);
  await pause(700);
}
shell.on("focus", () => {
  if (host)
    void host.focusWindow(owner).catch((e) => trace("host-focus-failed", { message: String(e) }));
});
await reset();
await record("visible-baseline", 3);
caseId = "app-loses-focus";
trace("action-started", { action: "outside-frame helper activate" });
await helper("show", { x: 1300, y: 100, width: 250, height: 250 });
await record("app-loses-focus", 6);
await reset();
caseId = "minimize";
trace("action-started", { action: "shell.minimize" });
shell.minimize();
await pause(450);
await record("minimize", 5);
shell.restore();
await pause(700);
await record("restore", 3);
await reset();
caseId = "cmd-h-equivalent";
trace("action-started", { action: "app.hide; Cmd-H native app-hide equivalent" });
app.hide();
await pause(450);
await record("cmd-h-equivalent", 5);
app.show();
shell.show();
shell.focus();
await pause(700);
await record("unhide", 3);
await reset();
const second = new BrowserWindow({ width: 900, height: 700, show: false });
await second.loadURL("data:text/html,<html><body>QA second shell Space</body></html>");
async function full(win: BrowserWindow, value: boolean, id: string) {
  caseId = id;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (value) {
      app.focus({ steal: true });
      win.show();
      win.moveTop();
      win.focus();
      await pause(350);
    }
    let entered = false;
    const event = value ? "enter-full-screen" : "leave-full-screen";
    const listener = () => (entered = true);
    win.once(event, listener);
    trace("fullscreen-request", { id, attempt, windowId: win.id, value });
    win.setFullScreen(value);
    await pause(3500);
    win.removeListener(event, listener);
    if (entered || win.isFullScreen() === value) {
      await pause(700);
      return;
    }
  }
  throw new Error("QA fullscreen did not complete " + id);
}
await full(shell, true, "first-enters-fullscreen");
await record("first-fullscreen", 3);
caseId = "switch-desktop-for-setup";
await helper("show", { x: 1300, y: 100, width: 250, height: 250 });
await pause(1500);
second.showInactive();
await full(second, true, "second-enters-fullscreen");
await record("second-fullscreen-selected", 4);
caseId = "space-return-first";
trace("action-started", { action: "focus existing first fullscreen Space" });
shell.focus();
await pause(1600);
await record("space-return-first", 4);
caseId = "space-switch-second";
trace("action-started", { action: "focus existing second fullscreen Space" });
second.focus();
await pause(1600);
await record("space-switch-second", 6);
await full(second, false, "leave-second-fullscreen");
second.hide();
await full(shell, false, "leave-first-fullscreen");
second.destroy();
await helper("quit");
