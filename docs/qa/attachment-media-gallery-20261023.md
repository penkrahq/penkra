# Unified media gallery and running-answer timestamps

## Reproduction

The operator reported that multiple presented videos stacked rather than using the
photo gallery, and that a working assistant message showed its clock timestamp.
Against `9ef1deb10`, four new assertions failed while 56 existing assertions passed:
video-only/mixed batches had no gallery, and a final candidate showed its timestamp
with both current and delayed active-turn flags.

The media row's gallery guard admitted only images. Timestamp display used the
final-candidate/copy-button flag without checking whether that answer's own turn
was still running. A final text item can be available before the terminal event;
neither text arrival nor eligibility for copying establishes turn completion.

## Implemented behavior

- One existing gallery shell for photos, videos, and mixed visual batches, with
  thumbnails, arrows and a counter. Ordinary files remain separate Open buttons.
- One native player implementation for single videos and gallery selection. The
  selected player pauses on disposal; selecting another item never autoplays it.
  Video thumbnails remain muted and non-playing. No playback-position cache.
- Photo expansion retains its image-only viewer and correct image index even when
  videos precede it in the gallery. Videos retain native playback/fullscreen controls.
- Assistant clock timestamps require a non-streaming final candidate whose own
  turn is not running. Completed older answers keep their times while a different
  turn runs. User timestamps and the live Working duration remain unchanged.
- No provider, queue, delivery, timestamp storage, schema, or runtime version change.

## Verification

- Web unit tests: 66 passed across transcript, media and normal resource opening.
- Browser tests: six passed across media and timestamp lifecycle. Real MP4/WebM
  decoding, playback and seeking; mixed thumbnail navigation, old-player pause and
  no autoplay on selection; image expansion; existing photo gallery layout/hover;
  and running-to-settled timestamp rendering. Screenshots in the adjacent folder
  were visually inspected.
- Workspace formatting/lint passed (869 existing warnings, zero errors). Workspace
  typecheck initially found two unbranded fixture Turn IDs; those were corrected
  and the affected web typecheck passed. No product schema was relaxed.
- The first new gallery browser invocation used an inexact label that also matched
  a thumbnail; the exact player label fixes the harness without weakening its checks.

The prior CI run `39904613555` failed the new codec fixture's seek assertions on
Linux after playback succeeded. Those fixtures now bind fully available blob URLs
before mounting and await actual seekability and `seeked`, rather than mutating a
live source and assuming an HTTP-served fixture is immediately seekable. This is
a browser-harness correction, not a product retry or fallback. Real attachment
HTTP byte-range tests remain in `localImageRoute.test.ts`.

## Local Production boundary

The preceding video/Open implementation was installed successfully as local 0.14.5:
updater `20261022-231221-623153`, exact app/backend PIDs 87587/87597, port 50980,
ASAR SHA-256 `a9fb66aa470fde82ff980c5dda919b60bbf5cf9843c268c20881529a62fce115`.
Readiness and process survival were independently verified. No migration/restoration.
Its first updater invocation rejected the local configured CLI model before changing
Production. A task-local invocation used the already-installed pinned CLI and an
available model; global configuration and product provider settings were unchanged.

This follow-up also retains version 0.14.5 locally. It does not replace published
assets or authorize a new public version. Its installation result is recorded only
after the canonical updater verifies it.

## Installed outcome

Canonical updater `20261023-000700-823953` reported UPDATE OK. Exact app/backend
PIDs 12149/12157 survived the launch helper and command session; port 60508 returned
version 0.14.5 and migration status ok. Installed ASAR matched the candidate:
`7a607b51ada95196dc30be1d0bea35b8b50e4425380b9f0a74b9094df1980eff`.
No fresh migration backup or database restoration. The previous bundle remains in
the canonical update directory for rollback.

Source commit `71abb716c46b13a4f09a02440481fd1e1d5904b7` passed every CI lane and the
quality gate in run `39909339077`, including both complete browser partitions.
The Linux media fixture checks that failed in the preceding run now pass; no test
was skipped to obtain that result. Server suite job duration was 5m27s.

The superseded stage and release artifacts from the preceding local update were
moved to Trash using the supported macOS trash command. Generated current staging
and scratch are likewise disposable after updater exit. Neither updater rollback
bundles nor user data are part of that cleanup; Trash is not emptied.
