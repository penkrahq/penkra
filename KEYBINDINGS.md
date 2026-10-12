# Keybindings

Penkra reads keybindings from:

- `~/.penkra/userdata/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "sidebar.toggle" },
  { "key": "mod+shift+g", "command": "chat.new" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+n", "command": "chat.new" },
  { "key": "mod+shift+o", "command": "chat.new" },
  { "key": "mod+shift+n", "command": "chat.newLocal" },
  { "key": "cmd+l", "command": "composer.focus.toggle" },
  { "key": "mod+o", "command": "editor.openFavorite" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `composer.focus.toggle`: focus or blur the chat prompt composer
- `editor.openFavorite`: open current project/worktree in the last-used editor

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `modelPickerOpen`
- `traitsPickerOpen`
- `isMac`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "modelPickerOpen"`
- `"when": "isMac && !modelPickerOpen"`
- `"when": "modelPickerOpen || traitsPickerOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
