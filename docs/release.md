# Penkra Desktop Releases

Penkra publishes its public desktop application through GitHub Releases. Stable releases are built
only by the protected GitHub workflow from an explicitly selected version and exact `main` commit.
The workflow validates every native artifact before it creates the immutable semantic-version tag,
then assembles one release and publishes those same bytes. Published update-capable artifacts are
then visible to `electron-updater`; the initial unsigned Windows installer remains manual-only.

The current release matrix is macOS arm64, macOS x64, Linux x64, and Windows x64. Each macOS
architecture uses a signed/notarized DMG plus update ZIP; release assembly merges both ZIP entries
into one architecture-aware updater manifest. Linux uses AppImage, and Windows initially uses an
explicitly unsigned NSIS installer. The Windows installer is a manual download: the release
deliberately omits `latest.yml` and the NSIS blockmap so unsigned builds cannot enter Penkra's
signature-verified auto-update path. Windows displays an Unknown publisher/SmartScreen warning until
a signing identity is provisioned.

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
from this repository at the same certified commit as the Electron application.

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
- The GitHub workflow uses a draft only as an atomic staging boundary while it combines the native
  artifacts. It publishes that draft in the same successful run; drafts are not a manual release
  queue or a separately installable channel.
- Penkra has no separate Canary app or data profile.

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

The version updater is authoritative for both the release package manifests and their matching
`bun.lock` workspace importer metadata. The lockfile-only Bun install then verifies dependency
consistency without owning release-version synchronization.

Commit the resulting package manifests and lockfile before starting the release workflow. Do not
create the matching tag manually: the workflow creates it only after every native artifact passes.

## Creating a release

1. Merge the intended release changes into `main` and confirm the fast aggregate CI gate passes for
   the exact commit. Commit CI covers static contracts, the complete unit and integration suites,
   deterministic browser partitions, the desktop build, and the React compiler hot-path contract.
   Native installer construction is intentionally reserved for the one release-candidate run.
2. In a signed-in Production Penkra task, ask the agent to run the registered command
   `penkra app status --app-id com.penkra.apps`. This is a Penkra host command available to agents;
   it is not a command provided by the client-workspace `penkra` shell executable. Confirm its
   result reports the lockfile's version and package digest as public on the production registry
   target. Stop if the target, version, or digest differs.
3. Update every product package to the intended version and commit the exact release source locally.
4. Complete the repository's required fresh Penkra Dev manual QA for the affected user flows, then
   build and launch an isolated local production package for final macOS QA. The local artifact is
   evidence, not publication authority, and must not replace or quit the installed Production app.
   Record the commands, timings, exercised flows, and result in the release handoff.
5. Dispatch the protected workflow with the approved version and exact current `main` commit:

   ```sh
   release_commit="$(git rev-parse HEAD)"
   gh workflow run release.yml --repo penkrahq/penkra \
     -f release_version="$approved_version" \
     -f source_commit="$release_commit"
   ```

6. The `Release Penkra Desktop` workflow:
   - verifies the requested version, current `main` commit, and package versions;
   - requires the aggregate Penkra CI quality gate to have passed for that exact commit;
   - consumes that commit-bound result instead of repeating the same validation suite;
   - builds each advertised platform on a native GitHub-hosted runner;
   - signs/notarizes macOS and emits Linux and explicitly unsigned Windows checksum/provenance
     evidence;
   - creates each installer, update payload, blockmap where applicable, and matching updater manifest
     together;
   - rejects any package containing the private `penkra-cli`;
   - records SHA-256 checksums and GitHub artifact attestations;
   - creates the immutable tag only after every native artifact passes;
   - creates or refreshes a draft solely to assemble all native outputs atomically;
   - publishes that exact draft as the latest stable release after every build and verification job
     succeeds, without a second build or a local artifact upload.
7. Query the canonical GitHub Release and verify that it is public stable, contains the complete
   platform matrix, and points to the certified commit. Then verify the normal production update UI
   discovers the published version. Installation and restart happen only when an operator chooses
   the released update; the release procedure never replaces the Penkra instance hosting itself.

If any platform fails, the workflow creates neither a tag nor a release. Fix the source, rerun source
CI and local QA, and dispatch the same still-unpublished approved version against the new exact
commit. Published assets are never replaced. A workflow retry is appropriate only when the source
commit is unchanged and the failure was in release infrastructure.

## Required GitHub configuration

Create a GitHub environment named `desktop-release`. Store the following secrets in that
environment:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Store `PENKRA_REGISTRY_TRUSTED_KEYS` as an environment variable containing a JSON array of the
production registry's Ed25519 public JWKs. The Desktop build pins these public keys and fails closed
when the variable is missing or malformed. During key rotation, publish a Desktop release containing
both the current and next public keys before the backend begins signing with the next private key.

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

The workflow uses only the repository-scoped `GITHUB_TOKEN` to stage and publish the GitHub Release.
It does not require AWS credentials, an update token, a private repository token, or a GitHub
personal access token.

## Release artifacts

Each stable release contains the applicable artifacts for its advertised platforms:

- `Penkra-<version>-arm64.dmg` for installation and recovery;
- `Penkra-<version>-arm64.zip` for Electron auto-update;
- `Penkra-<version>-x64.dmg` for installation and recovery on Intel Macs;
- `Penkra-<version>-x64.zip` for Electron auto-update on Intel Macs;
- both ZIP blockmaps used for differential downloads;
- `latest-mac.yml`, merged from the two finalized architecture-specific ZIP manifests;
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

Do not build or install a local artifact as release authority. In particular, release validation must
never replace `/Applications/Penkra.app` or quit the Penkra instance coordinating the release. The
tagged GitHub workflow is the sole source of production artifacts and performs native packaged
startup checks on every advertised platform.

An already-built artifact can be validated with:

```sh
bun run release:smoke:mac-update -- --artifact-dir release
```

When updater or packaging behavior changes, test the update path with the workflow's mock-update or
isolated native package harness before tagging. After publication, verify discovery from an existing
production installation and let Penkra's normal update UI own the user-approved install/restart.

## Release invariants

- A release is built from the exact certified commit and repository lockfile; its tag is created
  only after the native artifacts pass.
- Stable tags are exact `vMAJOR.MINOR.PATCH` values.
- Public artifacts never contain the private Penkra backend or CLI.
- macOS artifacts are Developer ID signed and Apple notarized.
- Final verified update payloads are the source for updater hashes, manifests, and blockmaps.
- Release builds and installed-App QA run natively on each advertised operating system.
- A release is published only after every native build, verification, checksum, and provenance job
  succeeds.
- Published release assets are never replaced. A correction receives a newer patch version.
