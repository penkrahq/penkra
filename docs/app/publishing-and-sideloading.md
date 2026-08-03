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
