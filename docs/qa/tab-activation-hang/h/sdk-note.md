# Window metadata API verification

Read the installed macOS SDK header at `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/CoreGraphics.framework/Headers/CGWindow.h`.

The declarations at lines 139–155 distinguish all-window enumeration (includes off-screen windows; ordering unspecified) from `kCGWindowListOptionOnScreenOnly` (front-to-back ordering). The key declaration around lines 121–125 specifies that absent `kCGWindowIsOnscreen` means the window is not ordered on screen. The accepted cover helper uses the ordered API for its rank and the all-window API for identities/bounds. The successful Space run uses only identity/on-screen membership; legacy rank labels are ignored.

No SDK source was modified or compiled, and no screen image was captured. Output metadata is filtered to scratch process IDs before writing evidence.
