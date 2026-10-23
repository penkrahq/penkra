# Transcript video playback and normal file opening

## Report and mechanism

The operator's screenshot shows `download-progress.mp4` and `cancel-download.mp4`
as Download pills. `PresentedMediaRow` rendered only images or download anchors;
`presentFile` recorded every non-image with `application/octet-stream`, and the
authenticated attachment route forced presented files to download. Stored file
objects can use `.bin`, so their storage extension is not their media type.
This was an unsupported presentation path, not evidence of damaged video bytes.

## Change

- Videos render a native, non-autoplaying player with controls and an Open action.
  Generic MIME metadata uses recognized video filename extensions; new presentations
  retain the filename's MIME type. No saved transcript or attachment migration.
- Ordinary files use Open. The authenticated attachment endpoint resolves the
  existing stored path; the existing Thread resource opener supplies the current
  Space/folder/Thread to the normal desktop routing policy. No forced Explorer
  destination, new preference, downloaded copy, or system-handler override.
- Sent file attachments use the same presentation component. Composer attachments
  and image expansion/gallery behavior remain unchanged.
- The attachment response derives MIME from the original name, supports single
  byte ranges with bounded file streaming, and leaves videos inline. Unsupported
  multipart ranges are ignored; unsatisfiable ranges return 416. If-Range cannot
  be validated for these mutable, no-store resources and therefore returns the
  whole representation. No ETag or shared caching was introduced.
- Metadata reads retain attachment authentication, containment, existence and size
  checks and no-store headers. Missing files produce the normal visible open error.
  Browser codec failures are visible and retain Open; no transcoding was added.

HTTP range semantics were checked against
[RFC 9110 section 14](https://www.rfc-editor.org/rfc/rfc9110.html#section-14).

## Verification

- Server: 30 tests passed across byte-range parsing, real HTTP attachment/preview
  serving, and durable media presentation (including an MP4 MIME assertion).
- Web: 61 tests passed across transcript rendering, file opening and presented
  media. Exact bridge payload proves no requested App is forced. Deleted files do
  not reach the opener. Current and generic-MIME MP4 rows render players.
- Chromium: four browser tests passed. Both the existing tiny WebM recording and
  a generated two-second H.264 MP4 decoded, played after user interaction, paused
  and sought; image gallery geometry and
  hover controls passed. This exercises real decoding separately from the real
  HTTP byte-range tests, not a claim of end-to-end playback through Production.
- Player screenshot visually inspected: `attachment-media-20261022/video-player.png`.
  The MP4 fixture is a generated solid-color clip, not user media.
- Root formatting, lint (869 existing warnings, zero errors), and all 11 workspace
  typecheck tasks passed. Subsequent narrow test changes were formatted; web
  typecheck and lint were rerun successfully.

The initial browser harness invocation attempted play without user activation and
was correctly rejected by Chromium. A subsequent harness edit used Playwright's
label API name instead of Vitest's; after using Vitest's actual user-click API,
all browser checks passed. Neither incident was hidden by changing product autoplay.

## Deployment boundary

Local Production candidate remains 0.14.5, with the same pinned required Apps
0.2.10/source `93b2ae9a1d0bc5285d357e317c3d5d4dea742cfe`. No public release,
registry App, backend service, provider version or database schema change is part
of this task. Installation outcome must be established by the canonical updater,
not inferred from a successful build.
