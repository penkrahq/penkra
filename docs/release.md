# Penkra Desktop Releases

Penkra publishes its public desktop application through GitHub Releases. Stable releases are built
from an exact semantic-version tag and published only after a draft release has passed native
installed-App QA on every advertised platform. Update-capable artifacts are exposed to
`electron-updater` only after that review; the initial unsigned Windows installer is manual-only.

The current release matrix is macOS arm64, Linux x64, and Windows x64. macOS uses a
signed/notarized DMG plus update ZIP, Linux uses AppImage, and Windows initially uses an explicitly
unsigned NSIS installer. The Windows installer is a manual download: the release deliberately omits
`latest.yml` and the NSIS blockmap so unsigned builds cannot enter Penkra's signature-verified
auto-update path. Windows displays an Unknown publisher/SmartScreen warning until a signing identity
is provisioned.

Runtime OS behavior is selected once through `apps/desktop/src/desktopPlatform.ts`. That adapter is
the authority for application identity, profile paths, shutdown semantics, encrypted credential
requirements, deep-link delivery and file-handler policy, browser permission prompts, notification and
icon behavior, window chrome, installer trust, and updater availability. Release packaging has a
separate build-time adapter in `scripts/lib/desktop-platform-build-config.ts`; both describe the
same three supported targets. Windows remains `manual-only` at runtime until the deferred Azure
signing work is deliberately activated with native signed-update evidence.

The initial desktop registers no operating-system file association. File and directory routing is
the explicit in-product App-intent/Open With flow, and an unresolved intent is handed to the
operating system. In particular, Canvas does not claim `.pen` files at the OS boundary.

The public desktop package does not contain the private Penkra backend or CLI. Account and hosted
service requests use the authenticated Penkra API. The desktop's local application runtime is built
from this repository at the same tagged commit as the Electron application.

This release workflow versions and publishes only the Penkra desktop product in this repository. It
does not publish registry Apps and does not version or deploy the Penkra backend. Registry Apps use
their own manifest versions and release process; backend deployments use their own source and
deployment process. An App compatibility range or a required backend deployment order may constrain
compatibility, but neither creates a shared release version.

One artifact dependency is deliberately pinned across those independent release lifecycles:
`com.penkra.apps` is required infrastructure and its approved registry archive is embedded in
Penkra. `required-apps.lock.json` records the exact App version, deterministic package digest,
and `penkrahq/penkra-apps` source commit. Desktop CI checks out that commit, rebuilds the archive,
and refuses packaging unless every locked identity and digest matches. This does not publish or
version Apps as part of the desktop release; the approved Apps version must already be public in
the production registry with the same digest before the desktop release is cut.

## Release channel and cadence

Penkra has one published channel: `stable`.

- Patch releases are made at most once per day and only when releasable fixes exist.
- Minor releases are made at most once per week and represent a coherent product milestone.
- Security or updater recovery releases may bypass the normal cadence.
- Releases are never created automatically from a schedule.
- `Penkra Dev` and its numbered local instances are development applications, not release channels.
- Release candidates use the signed draft-release workflow; Penkra has no separate Canary app or
  data profile.

## Version authority

The Git tag, GitHub Release, Electron version, workspace product-package versions, and updater
manifest must all use the same `MAJOR.MINOR.PATCH` version. Penkra remains on the `0.x` development
line until the user explicitly approves a different exact version.

Never infer a version from release cadence, repository history, change scope, or instructions such
as “release,” “clean cut,” or “proceed.” The user must explicitly approve the exact version before
changing a package manifest or lockfile, creating a tag, or publishing a GitHub Release.

Before describing a version as published or unpublished, query the canonical GitHub Release rather
than relying on local tags or package manifests. Local refs may be stale, and an installed version
does not by itself prove that its release remains public. Use `gh release view v<version>
--repo penkrahq/penkra` and record whether the release is a public stable release, draft, or
prerelease.

After the exact version is approved, prepare it with:

```sh
approved_version="<exact version approved by the user>"
node scripts/update-release-package-versions.ts "$approved_version"
bun install --lockfile-only --ignore-scripts
```

Commit the resulting package manifests and lockfile before creating the matching tag. Do not create
a release tag from an uncommitted or unreviewed worktree.

## Creating a release

1. Merge the intended release changes into `main` and confirm CI passes. The blocking CI gate builds
   unsigned native QA packages on Windows x64 and Linux x64, then launches each from isolated state.
   This catches platform-native PTY, packaging, installer extraction, desktop bootstrap, and embedded
   server failures before a release tag exists. Release signing remains isolated to the protected
   `desktop-release` environment.
2. Confirm `penkra app status --app-id com.penkra.apps` reports the lockfile's version and package
   digest as public on the production registry target. Stop if the target, version, or digest differs.
3. Update every product package to the intended version and commit the exact release source locally.
4. Build and verify the production artifact from that clean commit:

   ```sh
   bun run release:qa:local -- "$approved_version"
   ```

5. Install the verified artifact with `bun run release:install:local -- release-local`, then manually
   exercise the installed production application, including the changed behavior, normal
   message dispatch, an active-task interruption/relaunch, and a post-restart message. Inspect the
   desktop/backend logs and run SQLite integrity checking. Do not change the source or artifacts
   after this test. Record the result only after every check passes:

   ```sh
   bun run release:qa:approve -- "$approved_version"
   bun run release:qa:check -- "$approved_version"
   ```

6. Create and push the exact stable tag from the same approved commit, for example:

   ```sh
   git tag -a "v$approved_version" -m "Penkra v$approved_version"
   git push origin "v$approved_version"
   ```

7. The `Release Penkra Desktop` workflow:
   - verifies the tag and package versions;
   - requires the aggregate Penkra CI quality gate to have passed for the exact tagged commit;
   - consumes that commit-bound result instead of repeating the same validation suite;
   - builds each advertised platform on a native GitHub-hosted runner;
   - signs/notarizes macOS and emits Linux and explicitly unsigned Windows checksum/provenance
     evidence;
   - creates each installer, update payload, blockmap where applicable, and matching updater manifest
     together;
   - rejects any package containing the private `penkra-cli`;
   - records SHA-256 checksums and GitHub artifact attestations;
   - creates or refreshes a draft GitHub Release.
8. Download each draft installer and test it on a clean native account or test machine. Verify:
   - the platform's install/security flow accepts the application;
   - onboarding and account authentication complete;
   - the local desktop runtime starts;
   - the packaged version and source commit are correct;
   - update checks do not surface draft or prerelease builds.
9. On every advertised platform, test an actual installed previous version updating to the draft
   artifact, including restart and restored App tabs.
10. Publish the draft from GitHub only after every applicable check passes.

Draft releases are invisible to stable desktop update checks. Publishing the draft makes the
installer, update payload, and matching manifest available as one reviewed release.

## Required GitHub configuration

Create a GitHub environment named `desktop-release`. Store the following secrets in that
environment:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Azure Artifact Signing configuration is intentionally not part of the initial release
implementation. When that deferred work is activated, its credentials, publisher-subject pinning,
signed installer path, updater metadata, and native installed-update evidence must be implemented
and reviewed together.

Until then, Windows publication is limited to the
explicitly unsigned manual NSIS installer. It must not include `latest.yml` or an NSIS blockmap, and
release metadata must disclose the SmartScreen/Unknown publisher warning. Linux and Windows assets
carry final checksums and provenance; neither may be confused with a signed macOS installer.

The release workflow intentionally fails when required macOS signing/notarization is incomplete.
Linux AppImages are explicitly unsigned at the OS package layer and rely on exact
checksums plus GitHub build-provenance attestations; release metadata must not describe them as
code-signed.

The workflow uses only the repository-scoped `GITHUB_TOKEN` for draft release creation. It does not
require AWS credentials, an update token, a private repository token, or a GitHub personal access
token.

## Release artifacts

Each stable release contains the applicable artifacts for its advertised platforms:

- `Penkra-<version>-arm64.dmg` for installation and recovery;
- `Penkra-<version>-arm64.zip` for Electron auto-update;
- the ZIP blockmap used for differential downloads;
- `latest-mac.yml` generated from the same finalized ZIP;
- Linux AppImage, blockmap, and `latest-linux.yml` for the finalized artifact;
- `Penkra-<version>-x64.exe` as the explicitly unsigned manual Windows installer;
- `SHA256SUMS.txt`;
- GitHub build-provenance attestations.

GitHub Actions artifacts are temporary workflow handoffs. GitHub Release assets are the durable
distribution channel.

## Local verification

During implementation, run the commit-aware validation path to check only changed packages and
their dependents:

```sh
bun run verify:affected
```

This is an iteration accelerator, not a release gate. The complete local quality pass remains
mandatory before production-artifact QA:

```sh
bun run release:verify
```

Before creating a stable tag, the mandatory local production-artifact gate is:

```sh
bun run release:qa:local -- "$approved_version"
# Complete manual QA in the installed production app.
bun run release:qa:approve -- "$approved_version"
bun run release:qa:check -- "$approved_version"
```

This gate fails closed unless the worktree is clean, `main` is not behind `origin/main`, all product
manifests match the exact approved version, the local macOS artifacts pass production Developer ID
signing without notarization, and the installed artifact's hashes still match the QA receipt. The
receipt is stored in Git metadata and is bound to the exact commit and lockfile; any source or
artifact change invalidates it.

An already-built artifact can be validated with:

```sh
bun run release:smoke:mac-update -- --artifact-dir release
```

To install a verified local artifact while preserving the existing application as a timestamped
backup:

```sh
bun run release:install:local -- release
```

Run a genuine installed-version-to-new-version update on every advertised platform whenever updater
or packaging behavior changes.

## Release invariants

- A release is built from the exact tagged commit and repository lockfile.
- Stable tags are exact `vMAJOR.MINOR.PATCH` values.
- Public artifacts never contain the private Penkra backend or CLI.
- macOS artifacts are Developer ID signed and Apple notarized.
- Final verified update payloads are the source for updater hashes, manifests, and blockmaps.
- Release builds and installed-App QA run natively on each advertised operating system.
- Draft releases are reviewed before publication.
- Published release assets are never replaced. A correction receives a newer patch version.
