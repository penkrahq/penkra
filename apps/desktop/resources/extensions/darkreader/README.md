# Dark Reader for Penkra Browser

This directory contains the unpacked Chromium MV2 release build of Dark Reader 4.9.129,
built from https://github.com/darkreader/darkreader at tag `v4.9.129`.

The upstream UI, content scripts, and theme engine are unchanged. Penkra carries narrow Electron
compatibility adaptations for unsupported Chrome shell APIs: sync storage uses the Browser
session's local extension storage, toolbar/badge calls are host-owned no-ops, missing commands are
empty, and the host supplies the selected Browser page ID because Electron does not mark extension
tabs as active. The extension's MIT license is included as `LICENSE`.
