# Penkra Desktop Release

Penkra is currently an internal, private macOS arm64 application. Production updates use the gated
S3 feed behind `https://api.penkra.com/updates/mac/latest-mac.yml`. GitHub Releases and inherited
Synara versions are not Penkra release channels.

## Routine local release

1. Update `scripts/penkra-release.json` with a strictly newer Penkra version and the exact backend
   commit whose CLI should be bundled.
2. Add `docs/releases/<version>.md`.
3. Ensure the backend checkout beside this repository is at the pinned commit.
4. Export `PENKRA_UPDATE_TOKEN`, `PENKRA_RELEASE_BUCKET`, and the AWS credentials used by the
   production bucket.
5. Run:

   ```sh
   bun run release:desktop:local -- --publish
   ```

The command runs the local quality suite, rebuilds the pinned backend CLI, creates a signed ZIP-only
macOS arm64 release, removes the unused optional Claude platform binary, repacks and verifies the
Squirrel ZIP, regenerates its differential-update blockmap, runs the artifact smoke test, uploads
versioned files, and uploads `latest-mac.yml` last. Each major phase reports its duration.

Use `--skip-quality` only when the complete quality suite already passed for the exact working tree.
Use `--dmg` only when a drag-and-drop installer or recovery image is actually needed.

## Installing on this Mac

The production verification path is the running app's Update button. It proves discovery, download,
Squirrel handoff, restart, and installed-version reporting.

For routine internal iterations where updater behavior is unchanged, a verified release can instead
be installed without downloading the same ZIP back from S3:

```sh
bun run release:install:local -- release
```

The installer verifies the ZIP's signed app, moves the current application to a versioned backup,
copies the new bundle, verifies it again, and relaunches Penkra. Run a genuine N→N+1 in-app update
whenever updater or packaging code changes and before external distribution.

## GitHub Actions

`.github/workflows/ci.yml` and `.github/workflows/release.yml` are manual-only escape hatches. They do
not run on pushes or tags. This avoids hosted-runner spend while Penkra has one internal operator.
The quality workflow remains available for an occasional clean Ubuntu check; the release workflow
remains available for future protected signing/notarization use.

## Update invariants

- macOS auto-updates remain signed; notarization is deferred until external distribution.
- Routine production releases contain ZIP, `.zip.blockmap`, and `latest-mac.yml`. DMG is optional.
- The blockmap is generated from the final `ditto`-repacked and signature-verified ZIP, never from
  electron-builder's earlier archive.
- Artifacts are uploaded before the manifest, and older versioned artifacts remain available for
  differential downloads and rollback evidence.
- The publisher refuses a version that is not strictly newer than the live manifest.
- A Rosetta architecture switch uses a full download; native arm64 updates may use differential
  downloads and fall back to a full ZIP on any blockmap failure.

## Before external distribution

Provision a Developer ID Application certificate and Apple notarization credentials, restore an
appropriate CI/distribution policy, decide whether DMGs and additional platforms have named users,
and exercise a notarized update on a separate Mac.
