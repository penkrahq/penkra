ObjC.import("AppKit");
ObjC.import("Foundation");
const root = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("QA_ROOT"));
const control = root + "/helper-control.json",
  state = root + "/helper-state.json";
const native = $.NSApplication.sharedApplication;
native.setActivationPolicy(0);
native.finishLaunching;
const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  $.NSMakeRect(0, 0, 1200, 800),
  15,
  2,
  false,
);
win.title = "Penkra QA visibility helper";
win.backgroundColor = $.NSColor.blueColor;
win.collectionBehavior = 0;
let last = "",
  serial = null;
function write() {
  const row = {
    ready: true,
    serial,
    windowNumber: Number(win.windowNumber),
    collectionBehavior: Number(win.collectionBehavior),
    visible: Boolean(win.visible),
    fullscreen: Boolean(Number(win.styleMask) & Number($.NSWindowStyleMaskFullScreen)),
    pid: Number($.NSProcessInfo.processInfo.processIdentifier),
    active: Boolean(native.active),
    styleMask: Number(win.styleMask),
    frontPid: Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
    epochMs: Date.now(),
  };
  $(JSON.stringify(row)).writeToFileAtomicallyEncodingError(
    state,
    true,
    $.NSUTF8StringEncoding,
    null,
  );
}
write();
for (let i = 0; i < 2400; i++) {
  const data = $.NSData.dataWithContentsOfFile(control);
  if (data) {
    const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (text !== last) {
      last = text;
      const c = JSON.parse(text);
      serial = c.serial;
      if (c.action === "show") {
        win.setFrameDisplay(
          $.NSMakeRect(c.x || 0, c.y || 0, c.width || 1200, c.height || 800),
          true,
        );
        win.makeKeyAndOrderFront(null);
        win.orderFrontRegardless;
        native.activateIgnoringOtherApps(true);
        $.NSRunningApplication.currentApplication.activateWithOptions(3);
      }
      if (c.action === "hide") win.orderOut(null);
      if (c.action === "fullscreen") {
        win.makeKeyAndOrderFront(null);
        win.orderFrontRegardless;
        native.activateIgnoringOtherApps(true);
        $.NSRunningApplication.currentApplication.activateWithOptions(3);
        win.toggleFullScreen(null);
      }
      if (c.action === "quit") {
        win.close;
        break;
      }
    }
  }
  const event = native.nextEventMatchingMaskUntilDateInModeDequeue(
    $.NSEventMaskAny,
    $.NSDate.dateWithTimeIntervalSinceNow(0.1),
    $.NSDefaultRunLoopMode,
    true,
  );
  if (event) native.sendEvent(event);
  native.updateWindows;
  write();
}
