# Attachment viewer, 2026-10-15

Operator approved continuous dock following, empty-backdrop dismissal, wheel/pinch
zoom, enlarged-image pan, double-click zoom/reset and accessible +/-/Fit controls.

## Reproduction and change

The existing RightDock browser drag test now checks the overlay inset before
pointerup. Before the change it failed: dock width 660px, overlay inset 560px.
The sidebar writes its live width every animation frame; RightDock previously
wrote the overlay inset from the persisted width. The overlay now observes the
dock wrapper's actual size. Persistence remains release-only, and native App
bounds publication is unchanged. Opening and layout resizing use the same geometry.

ImageViewport owns one local transform for all input methods. Pan is constrained
against the current fitted image and viewport sizes, including after resize.
Changing image source remounts this local state at Fit. No provider/backend state,
dependency, migration or Production bundle changes are involved.

Empty viewport clicks and outer padding dismiss. Image clicks and captured pans
do not. Image pointer capture keeps subsequent clicks targeted at the image;
wheel handling is non-passive so it can cancel page scrolling. References:
[pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture),
[wheel events](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event).

## Verification

Changed browser files only: ExpandedImageOverlay.browser.tsx and
RightDock.browser.tsx, 11/11 passed. Cases include: live drag before release with
and without an App, dock navigation widths, empty viewer, previous/next/close,
right-dock interactivity, wide/tall image fitting, zoom controls, real double-click,
empty viewport and padding dismissal, wheel cancellation, mouse pan without
dismissal, two-pointer pinch, pan constraint after resize and image-change reset.
The new zoom-control case failed on the original viewer (controls absent).

Scoped `bun fmt` passed. `bun lint`: 865 warnings, zero errors. Workspace
`bun typecheck`: 11 successful tasks. A browser screenshot was inspected for
fitted layout, control placement and caption; this is component visual evidence,
not a claim that desktop QA completed.

## Desktop verification and local toolchain repair

The canonical Applications Penkra Dev launcher targets this checkout. Its original failure was Intel-only
`/usr/local/bin/bash` (EBADARCH). A process-local Bun-shell override got past
that boundary; local backend migration then failed spawning Intel-only
`/usr/local/bin/psql` (system error -86). No ARM psql was found at the standard
Homebrew locations.

The operator approved repairing the local toolchain. Installed ARM Homebrew bash
5.3.20 and libpq 18.6_1, with their Homebrew dependencies. After a dry-run link
check, `brew link --force libpq` exposed the native client in /opt/homebrew/bin.
Both bash and psql report arm64 and execute successfully. Intel tools remain
untouched; no shell profile or launcher code changed. The ordinary Dev launcher
then reached running, using localhost:5733 and the local account API on 3012.

Computer Use opened a repository PNG in an unsent empty Dev draft, opened the
Apps dock, and visually confirmed fitted image, caption and zoom controls.
Activating Zoom in enabled Zoom out in the accessibility state. Further painted
verification could not be established: Computer Use subsequently reported
noWindowsAvailable/changed-window errors, returned an unchanged image after a
state change, and later a gray window while AX exposed only the hosted Apps
content. The app/backend processes remained running. Do not claim completed
desktop drag/pan/zoom visual QA from these captures. The draft fixture was not
sent; its attachment remains in Dev's empty draft.

The operator requested 3x more responsive zoom during QA. Wheel/trackpad zoom
now applies a named sensitivity of 3 in log-zoom space, preserving reciprocal
zoom-in/out behavior. Button steps and direct touch distance-ratio pinch are
unchanged. The updated wheel assertion failed at scale(2) before the change and
passed at scale(8) afterwards; all 11 focused checks passed again. Scoped format
passed and web typecheck was rerun. Production was not restarted or modified.
