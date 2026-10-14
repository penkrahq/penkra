# Composer PNG reproduction, 2026-10-13

Report only, at `7dc97808d`. No composer code changed. Production was inspected only through the authenticated API; its database was not opened or edited.

## Environment and controls

Used `.claude/skills/verify/SKILL.md` with an isolated home at `~/penkra-rehearsal/composer-png-dev/penkra-home`, server port 3945 and Vite port 5945. The default Bun server launch correctly rejected its SQLite 3.51.0 runtime; the existing Node 24.19.0 (SQLite 3.53.3) ran the freshly built server instead. No runtime guard or host configuration was changed.

This is **Web Dev**, Chromium with no `desktopBridge`. It does not exercise Electron's native asset journal. Four canonical test threads were seeded in the isolated database. No provider turn was sent.

- Paste: real browser clipboard write of a PNG screenshot, followed by keyboard Meta+V.
- Drag: a browser `drop` event with a `DataTransfer` PNG `File`. This exercises the drop handler, **not a literal Finder drag**; native Finder serialization is not proved by this control.
- Picker: the real file input, supplied a PNG File through Playwright.
- Switch: in-app `appHistory` navigation to another thread and back, without reloading.
- Additional durability control: waited for the server's draft commit through its thread-change signal, then reloaded.

Raw observations: `/tmp/penkra-composer-report.json`. Driver: `/tmp/penkra-composer-png-dev.mjs`. Screenshots were presented with `penkra show` as paste, drag, picker, switch-back; the reload screenshot is `/tmp/penkra-composer-reload.png`.

## Observed matrix

| Input | Component | Type / MIME / preview | Warning | Click |
|---|---|---|---|---|
| Screenshot paste | ComposerImageAttachmentChip | image / image/png / blob: | Present | Opens image dialog |
| PNG drop control | ComposerImageAttachmentChip | image / image/png / blob: | Present | Opens image dialog |
| PNG picker | ComposerImageAttachmentChip | image / image/png / blob: | Present | Opens image dialog |
| Picker, switch away and back | ComposerImageAttachmentChip | image / image/png / blob: | Present | Opens image dialog |
| Full reload after server commit | No image chip | images empty; retained reference has size 0 | No chip | No preview button |

No case rendered FileAttachmentChip, an empty-preview IMG fallback, or the reported green PNG FileEntryIcon. All four click cases returned a usable expanded preview; `buildExpandedImagePreview` did not return null. Thus the historical unclickable green-icon composer occurrence remains unreproduced, and its introducing commit is unknown.

## Why the warning appears in these controls

`ChatView.tsx:386-438` stages a data URL in Web mode rather than calling `persistComposerAsset`; the desktop branch writes an asset and stages its blobKey. The controls staged valid data URLs, no blobKeys, and 80,851 bytes (clipboard re-encoding) or 85,921 bytes (drop/picker). There was no size rejection, FileReader error, or asset-write error: the Web asset write was skipped by that branch.

`composerDraftAttachments.ts:402-428` still calls the old localStorage verification. The fresh profile has no `penkra:composer-drafts:v1` entry. It returns unavailable and puts retained image IDs into `nonPersistedImageIds`. `ChatView.tsx:2445-2452` removes only IDs having a blobKey; these data-URL IDs remain. `ComposerImageAttachmentChip.tsx:54-63` consequently draws the orange badge. Its click (`:30-33`) independently builds a preview from the valid blob URL and opens it. The badge did not obstruct clicking.

This warning cannot be described simply as false: the Web bytes are not durable. `serializeComposerThreadDraft` (`composerDraftPersistence.ts:843-919`) saves only id/name/MIME references. Reload hydration reconstructs a blobKey from the id, but `readComposerAsset` finds no bytes, returns null, and the image cannot hydrate. The extra reload control measured exactly that: no live image, one retained reference, size 0, no dataUrl, missing asset.

## History boundary

`3850cff2f` (Step 8, draft on the server) is the first post-v0.14.3 commit removing the zustand localStorage persistence while keeping the localStorage attachment-verification path. It also introduced the reference-only server draft route used here. That is the source boundary for these Web warning/durability mismatches. The warning and preview components themselves are unchanged between v0.14.3 and this source; no new click policy was introduced there. A same-case native v0.14.3/HEAD comparison was not performed, so this report does not claim a proven native desktop regression or an introducing commit for the green icon.

The separate **transcript** omission is present from `9676a9088`: the new canonical mapper and ThreadItemRow passed image metadata straight through without deriving the authenticated preview URL. `90c2931ce` switched the live transcript to useThreadItems/ThreadItemRow, activating that path; `851b2ea57` then retained the omission in the single MessagesTimeline renderer. The v0.14.3 orchestration normalizer derived it. `7dc97808d` fixes that mapper; its failing-before/passing-after regression also exercises expansion. This must not be confused with the unreproduced composer occurrence.

## Production delivery evidence

Migration 203 and the installed P0 stream/delivery changes already address the null-sender and subscriber re-entry failures. The 13:24 and 14:55 sends preceded `4eb7a962b`, so the defect path left sending rows without an error log. Later explicit failures at 17:08 and 17:15 surfaced the null-sender error while the failed cohort's retained mention read Strategy. The 16:45-16:54 backend silence and Strategy delay match the separately established subscriber re-entry loop. No evidence supports explaining these rows as successful native steers.

The current API read of the reviewer thread is idle, latest turn completed, lastError null. The five delayed user rows are sent; server.log at 00:58:35 records a five-member delivery with two images, `rebuiltHistory=false`. Both original screenshots and the original Strategy PNG return HTTP 200 image/png with intact content. This does not prove why every historical provider exit occurred, nor promise that the generic provider cut-off notice can never recur.
