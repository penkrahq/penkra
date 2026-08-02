# Pencil-to-code component map

`penkra.pen` is the UI structure authority. Code mirrors its user-visible groups directly; this
document records ownership, not a separate product plan.

| Pencil group | Code owner                                                                   | Composition root                                        |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| Foundations  | `apps/web/src/components/foundations/`                                       | Shared controls used by every region                    |
| Left Rail    | `apps/web/src/components/left-rail/`                                         | `LeftRail` and `Sidebar`                                |
| Middle Panel | `apps/web/src/components/middle-panel/`                                      | `SingleChatSurface` / `ChatView`                        |
| Right Panel  | `apps/web/src/components/right-panel/`                                       | Right-dock pane and tab composition                     |
| App Bar      | `packages/ui/src/` and `apps/web/src/components/right-panel/app-bar-shared/` | App-owned framework-neutral primitive plus host preview |
| Account menu | `apps/web/src/components/left-rail/menu-account/`                            | `AccountMenu`                                           |
| Settings     | `apps/web/src/components/settings/`                                          | Settings shell and page folders                         |

Reusable components keep the Pencil name in their directory and Storybook title. A component used
by more than one region belongs in Foundations; region-specific composition stays with that region.
The web renderer never embeds Pencil or an iframe runtime.

Screen ownership is intentionally separate from component ownership:

- the shell owns rail/panel geometry, tab containment, trusted Settings, and the fixed Apps launcher;
- an App renderer owns its page content and optional App Bar;
- `penkra-apps/apps/design/apps.pen` owns the Apps App flows;
- `penkra-website/penkra-website.pen` owns public authentication and website flows.
