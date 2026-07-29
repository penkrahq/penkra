# Penkra design pass

Last audited: 2026-07-28

## Source of truth

- `/Users/emmanuelgyekyeatta-penkra/Desktop/penkra.pen` is the authoritative product
  design and is reproduced verbatim.
- `PENKRA.md` provides architecture context where it agrees with Pencil.
- `STORIES.md` provides user-outcome context where it agrees with Pencil.
- `public/pencil/` contains the exported visual assets used by the prototype.

This repository is the implementation surface. The audit does not modify the Pencil file.

## Implemented visual inventory

The prototype renders and captures these fifteen exported screens:

1. Welcome
2. Connect an agent
3. Manage connections
4. Enter API key
5. Install initial apps
6. Workspace
7. Apps panel
8. Permission request
9. General settings
10. Permissions settings
11. Agents settings
12. Apps settings
13. Connectors settings
14. Appearance settings
15. Account settings

Supporting exported overlays include the account menu, quick settings, harness menu,
model submenu, and permission sheet.

## Verified prototype behavior

- Onboarding advances through agent selection, connection, API-key entry, initial apps,
  and the workspace.
- Agent and initial-app cards retain their selected state during the session.
- API-key entry rejects an empty value.
- Workspace folders and threads respond to selection and collapse controls.
- The composer accepts a draft and appends a mock user message.
- The side panel opens and closes.
- Account and quick-settings overlays open from the workspace.
- All seven settings navigation destinations are reachable.
- Escape and backdrop dismissal return from settings and permission overlays.
- The permission phase contains exactly one centered permission sheet.
- Fifteen deterministic reference captures are generated under
  `.qa-artifacts/design-captures/`.

Run the verification with:

```sh
npm run smoke
npm run capture:designs
```

## Current design coverage

| Product area | Current state |
|---|---|
| First run and model connection | Designed and interactive as a prototype |
| API-key entry | Designed and interactive as a prototype |
| Initial app choice | Designed and interactive as a prototype |
| Core workspace shell | Designed and interactive as a prototype |
| App panel chooser | Designed; selection behavior is only partially represented |
| Install permission review | Designed as a standalone prototype state |
| General settings | Designed with representative content |
| Permissions settings | Navigation shell and heading only |
| Agents settings | Navigation shell and heading only |
| Apps settings | Navigation shell and heading only |
| Connectors settings | Navigation shell and heading only |
| Appearance settings | Navigation shell and heading only |
| Account settings | Navigation shell and heading only |
| Files and editor | Tab affordance only; detailed states are not exported |
| Browser | App-list affordance only; detailed states are not exported |
| Search, recovery, offline, and failure states | Not represented in the exported screen set |
| App discovery, detail, update, uninstall, and audit flows | Not represented in the exported screen set |

## Source differences

The references do not currently agree in several places. These are not blockers because
Pencil wins:

- `PENKRA.md` excludes Terminal from v1, while the exported workspace lists Terminal.
- `PENKRA.md` defines a knowledge-worker product without core development affordances,
  while the exported shell contains developer-oriented navigation and examples.
- `STORIES.md` describes app discovery, detail, install, update, removal, and permission
  audit flows that have no corresponding exported screens.
- The standalone permission screen has no visible entry point from the currently empty
  Apps settings body.

The application retains the Pencil behavior and copy in every case. No visual correction
is inferred from written architecture or stories.

## Gate before console code reuse

Console code should not be ported into a product area until:

1. Its `D1` user stories have approved visual states.
2. The destination exists in the current Pencil design.
3. The prototype navigation reaches those states.
4. The smoke flow covers the intended transitions.
