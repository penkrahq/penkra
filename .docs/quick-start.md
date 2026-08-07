# Quick start

```bash
# Development (with hot reload)
bun run dev

# Install the standard desktop development Apps, then launch one from Applications
bun run dev:desktop:install-app
# Penkra Dev, Penkra Dev 2, or Penkra Dev 3

# Provision another stable desktop slot
bun run dev:desktop:install-app -- 4

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Or from any project directory after publishing:
npx penkra
```
