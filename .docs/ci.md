# CI quality gates

- `.github/workflows/ci.yml` runs the blocking static, workspace, server, browser, build, migration, and release-smoke lanes on pull requests and pushes to `main`. It also builds unsigned native Windows x64 and Linux x64 QA packages and launches them from isolated state before a commit can satisfy the aggregate quality gate.
- `.github/workflows/release.yml` publishes macOS arm64 and Linux x64 from one `v*.*.*` tag, with native runners and one draft GitHub release. Windows x64 remains a blocking native CI target but is not advertised or published until its signing identity is provisioned and its installer/update QA is complete.
- Publication fails closed when Apple Developer ID/notarization is unavailable. Linux AppImages are currently unsigned at the OS package layer and instead require exact checksums plus GitHub build-provenance attestations; they must never be described as code-signed.
- See `docs/release.md` for full release/signing setup checklist.
