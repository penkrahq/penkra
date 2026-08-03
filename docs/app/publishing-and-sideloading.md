# Publishing and sideloading

Sideloading is for local development. A sideloaded App uses the same manifest validation,
permissions, isolation, and runtime as a registry App. IDs and slugs never alias or override an
installed App: uninstall the collision or change the sideload's identity.

Registry publication binds the signed-in owner, publisher domain evidence, immutable App ID and
version, manifest/package/README/instructions digests, publisher signature, registry signature,
compatibility, validation findings, and permission declarations. Packages and assets are immutable
objects; metadata and lifecycle state remain relational. Automated validation completes before a
release is eligible for installation.

The desktop verifies identity, signatures, digests, compatibility, and signed security policy
before activation. Installation, update, rollback, disable, uninstall, and retained-data removal
are scoped to one Space. Successful-install receipts are account/App deduplicated and do not count
updates, reinstalls, other devices, or sideloads.

## Complete registry workflow

The App developer commands use the signed-in Penkra desktop session. Keep Penkra running while
using publisher, registry, submission, visibility, or access commands.

```sh
# Exercise the real isolated host and produce a deterministic package.
penkra app preflight ./dist --output ./my-app.penkra

# Create the publisher once. Use `publisher list` on subsequent releases.
penkra app publisher create \
  --slug acme \
  --name "Acme" \
  --domain acme.example
penkra app publisher list

# Create the stable App identity once. Visibility is explicit.
penkra app registry-app create \
  --publisher-id <publisher-id> \
  --identifier com.acme.canvas \
  --slug canvas \
  --name "Canvas" \
  --summary "Create visual documents." \
  --visibility public
penkra app registry-app list --publisher-id <publisher-id>

# Package, keyless-sign, upload, finalize, and enqueue automated validation.
penkra app submit ./dist \
  --app-id <app-id> \
  --output ./canvas.penkra \
  --bundle ./canvas.sigstore.json \
  --issuer https://github.com/login/oauth

penkra app submission list --app-id <app-id>
penkra app submission get <submission-id>
```

`submit` requires Cosign. It never accepts a caller-provided trusted signer label: the backend
verifies the keyless bundle, issuer, signed-in publisher ownership, package evidence, and immutable
version before publication.

## Private Apps

Visibility belongs to the stable App identity, so every version has the same discovery boundary. A
private App is visible only to its publisher owner and invited verified accounts.

```sh
penkra app visibility set --app-id <app-id> --visibility private
penkra app access invite --app-id <app-id> --email teammate@example.com
penkra app access list --app-id <app-id>
penkra app access revoke --app-id <app-id> --invitation-id <invitation-id>
```

Invited users see the private App in ordinary Apps search and may open its detail page, download a
release, install it, and receive updates. Other authenticated users receive the same not-found
response as an unknown App. Private package, README, instruction, icon, and screenshot URLs remain
short-lived authenticated downloads.

Changing visibility does not create a package version. Changing code, manifest data, README,
instructions, permissions, or assets does and therefore requires another submission.

## Local development

Launching Penkra (Dev) applies migrations, seeds the local accounts, and idempotently publishes
Apps, Explorer, and Browser into the local registry with the development workspace's persistent
signing identity. Space bootstrap then installs those signed releases through the same registry
installer used for every other App. Nothing is copied from a sibling repository into the desktop
bundle.

From `penkra-backend`, `pnpm local:seed` reruns the account and registry seeds. It reuses the
persistent identity in `PENKRA_DEV_ROOT` (default `~/Penkra_Dev`) and refuses to mutate an already
published version whose bytes changed; change the package only alongside an explicitly approved
version bump.

Use `penkra app test ./dist` for an isolated disposable host. To exercise an unpacked App inside a
normal development Space, start Penkra Dev with an explicit directory:

```sh
PENKRA_SIDELOAD_APP_PATH=/absolute/path/to/dist bun run dev
```

Sideloading is the only non-registry distribution path. It is conspicuously labeled, has no
registry listing, ratings, install receipts, or automatic updates, and cannot override an installed
registry App with the same ID or slug.
