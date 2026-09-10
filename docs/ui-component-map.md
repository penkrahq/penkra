# UI component map

Approved Penkra Canvas designs define visible composition, states, and interactions. The codebase
and Storybook define implementation ownership and reusable-component structure. This document
records that ownership; Canvas node grouping does not independently reorganize source code.

| Product region | Code owner                                                                   | Composition root                                        |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| Foundations    | `apps/web/src/components/foundations/`                                       | Shared controls used by every region                    |
| Left Rail      | `apps/web/src/components/left-rail/`                                         | `LeftRail` and `Sidebar`                                |
| Middle Panel   | `apps/web/src/components/middle-panel/`                                      | `SingleChatSurface` / `ChatView`                        |
| Right Panel    | `apps/web/src/components/right-panel/`                                       | Right-dock pane and tab composition                     |
| App Bar        | `packages/ui/src/` and `apps/web/src/components/right-panel/app-bar-shared/` | App-owned framework-neutral primitive plus host preview |
| Account row    | `apps/web/src/components/left-rail/account-control-shared/`                  | `AccountControlShared`                                  |
| Settings       | `apps/web/src/components/settings/`                                          | Settings shell and page folders                         |

Keep composed screens separate from reusable components. A component used by more than one region
belongs in Foundations when that shared ownership is intentional; region-specific composition stays
with that region. The web renderer does not embed the design editor or its runtime.

Screen ownership remains separate from component ownership:

- the shell owns rail/panel geometry, tab containment, trusted Settings, and the fixed Apps launcher;
- an App renderer owns its page content and optional App Bar.
