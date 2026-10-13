# Penkra release and local Production update

Work from the approved `main` commit. Do not bump versions, tag, push or publish without the
operator's approval for that exact action and version. Desktop releases do not publish registry
Apps, npm packages or the hosted backend.

## Verify the source

```sh
bun typecheck
(cd apps/server && bun run test src/persistence/Migrations.test.ts)
(cd apps/server && bun run test src/cleanCore/*.test.ts)
git rev-parse HEAD
git status --short
```

These are the operator's 0.14.4 verification gates. The operator performs manual verification.
Record their results and the rehearsal report in `docs/clean-0144-notes.md`. Production must be
quit only for a consistent read-only snapshot. Never copy a live SQLite file with a filesystem
copy and never modify Production's database by hand.

```sh
sqlite3 'file:<Production-state.sqlite>?mode=ro' "VACUUM INTO '<scratch>/state-copy.sqlite';"
sqlite3 'file:<scratch>/state-copy.sqlite?mode=ro' 'PRAGMA integrity_check;'
```

Reopen Penkra after the copy. Rehearse only on a fresh `VACUUM INTO` of that verified copy.
Report threads, messages, children preserved, native owners, native-folder moves, retained-folder
cleanup, foreign keys, rollback, duration, size and free pages. Stop on any preservation failure.

## Build and sign without installing

Use the existing package version until a version change is explicitly approved. The build pins
registry trust keys and `required-apps.lock.json`; it fails if required signed App artifacts are
missing or mismatched. For this local update, use the Mac
Developer ID certificate and `--local-sign`; notarization is required only for publication.

```sh
bun scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --local-sign \
  --keep-stage --output-dir '<scratch>/release'
# --keep-stage leaves the app under the penkra-desktop-mac-stage-* path logged by the build.
find '<worktree-parent>/penkra-desktop-mac-stage-<id>/app/dist' -name Penkra.app -print
codesign --verify --deep --strict '<path-to-new-Penkra.app>'
spctl --assess --type execute '<path-to-new-Penkra.app>'
```

The local build uses Developer ID signing without notarization; retain its staged app. `codesign`
is mandatory. `spctl` is informational for this locally built app with no quarantine flag. Do
not remove quarantine or change Gatekeeper settings. The publishing `--signed` path also requires
notarization and stapling. The supported public matrix remains macOS arm64/x64, Linux x64 and
Windows x64. Unsigned Windows installers stay manual-only.

## Update this Mac only after approval

Confirm the rehearsal passed and the candidate has a verified Developer ID signature. Obtain the
reviewer's final confirmation before invoking the updater. It does not publish anything.

```sh
PENKRA_UPDATE_CODEX_BIN='<standalone-codex-executable>' \
  scripts/update-production.sh '<path-to-new-Penkra.app>'
```

The launcher verifies Developer ID `codesign` before changing anything (and records `spctl`
informationally), writes a prompt under
`~/Penkra/.penkra/updates/<timestamp>/`, and double-forks exactly one standalone Codex outside
Penkra. It prints **Updater started; Penkra will quit and relaunch.** Do not use `launchctl submit`:
it relaunches the updater when it exits.

The detached agent performs the written transaction, logging each command and result:

1. Verify the candidate again; record its version and the current log boundaries.
2. Register native process-exit watchers, ask Penkra to quit, and wait for exit without sleeps.
3. Move `/Applications/Penkra.app` to the update directory, then install with `ditto` and verify.
4. Launch the installed executable as an owned child. Watch new log writes and process exit.
5. Request the new local `/status` after its listening event. It waits for server readiness and
   reports the actual migration startup result plus `PENKRA_APP_VERSION`. Require the expected
   version and migration status `ok`. Log lines (including bootstrap warnings) are progress only,
   never a success or failure signal. There is no startup deadline; a snapshot and upgrade can
   take several minutes. Fail only on a reported migration failure or app/backend process exit;
   record progress every minute without cancelling startup.
6. On failure, stop the candidate, restore and launch the old bundle, and record the result.
   If migration committed, move the closed current `state.sqlite` and `-wal`/`-shm` into
   `failed-db/`, copy `state.pre-0.14.4.sqlite` into place, and require read-only
   `integrity_check=ok` before relaunching the old app. Never delete or edit either database or
   backup. Keep both app bundles. Do not touch userdata's backup directory or `.corrupt` files.
   The restored 0.14.3 app uses `/health` with `startupReady=true`; its `/status` is HTML, not JSON.
7. Write `update.log` and `report.md`, show a macOS notification, and exit after one attempt.

Read the final report after Penkra reopens:

```sh
ls -dt ~/Penkra/.penkra/updates/*/ | head -1
cat '<newest-update-directory>/report.md'
cat '<newest-update-directory>/update.log'
```

The app owns its first-start database backup and migration. Keep the previous app and database
backup until the operator chooses to delete them. A broken-build rollback exercise requires its
own disposable instance; it must not deliberately break Production.

## Publish a desktop release only when approved

The protected workflow builds exact committed source and handles release assembly. Keep its
live version/provenance tools; local installation is not publication.

```sh
node scripts/update-release-package-versions.ts '<approved-version>'
git diff -- apps/server/package.json apps/desktop/package.json apps/web/package.json \
  packages/contracts/package.json bun.lock
# Commit the approved version changes before dispatching.
release_commit="$(git rev-parse HEAD)"
gh workflow run release.yml --repo penkrahq/penkra \
  -f release_version='<approved-version>' -f source_commit="$release_commit"
gh release view 'v<approved-version>' --repo penkrahq/penkra
```

`verify-release-source-provenance.ts` checks exact commit, clean source, aligned versions and
lockfile hash. `write-release-artifact-provenance.ts` records the final native artifact trust
proof. `release-smoke.ts` checks version/manifest packaging helpers; it is retained for release
workflow use and is not an additional 0.14.4 local test gate. Follow the workflow's existing
checksum, signing and update-feed verification before the operator publishes. GitHub update URLs
and Electron's network updater remain distinct from the local detached transaction.

## Public npm packages are separate releases

Obtain explicit package/version approval first. The existing `npm-publish.yml` uses npm trusted
publication with OIDC and provenance; no npm token belongs in this repository.

```sh
npm trust github @penkra/sdk --repo penkrahq/penkra --file npm-publish.yml --env npm --allow-publish --yes
npm trust github @penkra/ui --repo penkrahq/penkra --file npm-publish.yml --env npm --allow-publish --yes
# Commit only the approved package version and lockfile changes, then dispatch its existing workflow.
gh workflow run npm-publish.yml --repo penkrahq/penkra --help
```

Configure the protected GitHub `npm` environment and trusted publisher before the first release.
Approve its deployment only after reviewing the package and version. Confirm registry provenance
and the exact immutable version afterward.
