# Penkra Desktop Releases

Penkra publishes its public macOS desktop application through GitHub Releases. Stable releases are
signed, notarized, built from an exact semantic-version tag, and exposed to `electron-updater` only
after a draft release has passed manual installation and startup QA.

The public desktop package does not contain the private Penkra backend or CLI. Account and hosted
service requests use the authenticated Penkra API. The desktop's local application runtime is built
from this repository at the same tagged commit as the Electron application.

## Release channel and cadence

Penkra has one published channel: `stable`.

- Patch releases are made at most once per day and only when releasable fixes exist.
- Minor releases are made at most once per week and represent a coherent product milestone.
- Security or updater recovery releases may bypass the normal cadence.
- Releases are never created automatically from a schedule.
- `Penkra (Dev)` is a local development application, not a release channel.

## Version authority

The Git tag, GitHub Release, Electron version, workspace product-package versions, and updater
manifest must all use the same `MAJOR.MINOR.PATCH` version. Penkra remains on the `0.x` development
line until the user explicitly approves a different exact version.

Never infer a version from release cadence, repository history, change scope, or instructions such
as “release,” “clean cut,” or “proceed.” The user must explicitly approve the exact version before
changing a package manifest or lockfile, creating a tag, or publishing a GitHub Release.

After the exact version is approved, prepare it with:

```sh
approved_version="<exact version approved by the user>"
node scripts/update-release-package-versions.ts "$approved_version"
bun install --lockfile-only --ignore-scripts
```

Commit the resulting package manifests and lockfile before creating the matching tag. Do not create
a release tag from an uncommitted or unreviewed worktree.

## Creating a release

1. Merge the intended release changes into `main` and confirm CI passes.
2. Update every product package to the intended version and merge that version commit.
3. Create and push the exact stable tag, for example:

   ```sh
   git tag -a "v$approved_version" -m "Penkra v$approved_version"
   git push origin "v$approved_version"
   ```

4. The `Release Penkra Desktop` workflow:
   - verifies the tag and package versions;
   - runs formatting, linting, typechecking, tests, and release contract checks;
   - builds macOS arm64 on a standard GitHub-hosted runner;
   - signs and notarizes the application and DMG;
   - creates the DMG, update ZIP, blockmap, and `latest-mac.yml` together;
   - rejects any package containing the private `penkra-cli`;
   - records SHA-256 checksums and GitHub artifact attestations;
   - creates or refreshes a draft GitHub Release.
5. Download the draft DMG, install it on a clean Mac account or test Mac, and verify:
   - Gatekeeper accepts the application;
   - onboarding and account authentication complete;
   - the local desktop runtime starts;
   - the packaged version and source commit are correct;
   - update checks do not surface draft or prerelease builds.
6. Publish the draft from GitHub only after those checks pass.

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

The release workflow intentionally fails when signing or notarization is incomplete. It does not
produce unsigned public releases.

The workflow uses only the repository-scoped `GITHUB_TOKEN` for draft release creation. It does not
require AWS credentials, an update token, a private repository token, or a GitHub personal access
token.

## Release artifacts

Each stable macOS arm64 release contains:

- `Penkra-<version>-arm64.dmg` for installation and recovery;
- `Penkra-<version>-arm64.zip` for Electron auto-update;
- the ZIP blockmap used for differential downloads;
- `latest-mac.yml` generated from the same finalized ZIP;
- `SHA256SUMS.txt`;
- GitHub build-provenance attestations.

GitHub Actions artifacts are temporary workflow handoffs. GitHub Release assets are the durable
distribution channel.

## Local verification

The complete local quality pass remains:

```sh
bun run release:verify
```

An already-built artifact can be validated with:

```sh
bun run release:smoke:mac-update -- --artifact-dir release
```

To install a verified local artifact while preserving the existing application as a timestamped
backup:

```sh
bun run release:install:local -- release
```

Run a genuine installed-version-to-new-version update whenever updater or packaging behavior
changes.

## Release invariants

- A release is built from the exact tagged commit and repository lockfile.
- Stable tags are exact `vMAJOR.MINOR.PATCH` values.
- Public artifacts never contain the private Penkra backend or CLI.
- macOS artifacts are Developer ID signed and Apple notarized.
- The final verified ZIP is the source for updater hashes and blockmaps.
- Draft releases are reviewed before publication.
- Published release assets are never replaced. A correction receives a newer patch version.
