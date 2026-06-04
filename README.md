# overleaf.nvim

Neovim plugin for real-time collaborative LaTeX editing on [Overleaf](https://www.overleaf.com).

Edit your Overleaf projects directly in Neovim with full real-time collaboration support via Operational Transformation (OT). Use your favorite Neovim plugins — treesitter, LSP, snippets, copilot, and more — while collaborating with others on Overleaf.

## Features

- **Real-time collaboration** — edits sync instantly with other Overleaf users via OT
- **Full Neovim ecosystem** — treesitter, LSP, snippets, copilot, and all your plugins work out of the box
- **File tree** — browse and manage project files in a sidebar
- **Auto-authentication** — extracts session cookie from Chrome or Arc automatically (macOS)
- **Auto-reconnect** — recovers from disconnects and document restores seamlessly
- **Compile & PDF preview** — compile LaTeX and open the PDF
- **Comments & reviews** — view, reply, resolve comment threads; open ranges render as diagnostics
- **Collaborator cursors** — see where other users are editing
- **Project-wide search** — grep across all documents
- **Picker integration** — use snacks.picker for project, document, and search result pickers when available
- **File management** — create, delete, rename, upload files
- **History** — view project version history
- **Diagnostics** — chktex linter + LaTeX compile errors via `vim.diagnostic`
- **LSP support** — auto-attaches texlab, ltex, harper_ls to overleaf buffers
- **Local file sync** — mirror documents to disk for external tools (Claude Code, etc.)

## Requirements

- Neovim >= 0.10
- Node.js >= 18
- An [Overleaf](https://www.overleaf.com) account
- Chrome or Arc (for automatic cookie extraction on macOS) or a session cookie

## Installation

### lazy.nvim

```lua
{
  'richwomanbtc/overleaf.nvim',
  config = function()
    require('overleaf').setup()
  end,
  build = 'cd node && npm install',
}
```

If Node.js is not on your default PATH (e.g., installed via Homebrew on macOS):

```lua
{
  'richwomanbtc/overleaf.nvim',
  config = function()
    require('overleaf').setup({
      node_path = '/opt/homebrew/bin/node',
    })
  end,
  build = 'cd node && npm install',
}
```

### Manual

```sh
git clone https://github.com/richwomanbtc/overleaf.nvim ~/.local/share/nvim/lazy/overleaf.nvim
cd ~/.local/share/nvim/lazy/overleaf.nvim/node && npm install
```

## Authentication

### Option 1: Browser (automatic)

Just log in to [overleaf.com](https://www.overleaf.com) in Chrome or Arc. The plugin extracts the session cookie automatically (macOS). If more than one browser profile is available, you'll be prompted to select one.

### Option 2: Manual cookie

Create a `.env` file in your working directory:

```
OVERLEAF_COOKIE=your_overleaf_session2_cookie_here
```

Or pass it directly in setup:

```lua
require('overleaf').setup({
  cookie = 'your_overleaf_session2_cookie_here',
})
```

> **Warning:** If you use this method, make sure your Neovim config is not committed to a public dotfiles repository — the cookie would grant full access to your Overleaf account.

To get the cookie manually: open overleaf.com in your browser → DevTools (F12) → Application → Cookies → `www.overleaf.com` → find `overleaf_session2` → copy the cookie value (starts with `overleaf_session2=s%3A...`).

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `:Overleaf projects` | Authenticate/connect if needed, or switch project |
| `:Overleaf status` | Show connection status |
| `:Overleaf disconnect` | Disconnect |
| `:Overleaf compile` | Compile LaTeX project |
| `:Overleaf compile local` | Compile locally once |
| `:Overleaf compile watch` | Start local watch compile |
| `:Overleaf compile stop` | Stop local watch compile |
| `:Overleaf explorer` | Open the configured explorer |
| `:Overleaf explorer native` | Open the built-in tree |
| `:Overleaf files` | Open the document picker |
| `:Overleaf preview` | Preview binary file (images, etc.) |
| `:Overleaf new [name]` | Create new document |
| `:Overleaf mkdir [name]` | Create new folder |
| `:Overleaf delete` | Delete file/folder |
| `:Overleaf rename` | Rename file/folder |
| `:Overleaf upload [path]` | Upload local file |
| `:Overleaf search [pattern]` | Search across all documents; without a pattern, open the live search picker |
| `:Overleaf comment add` | Create a comment on the current visual selection |
| `:Overleaf comment show` | Show the comment thread under the cursor |
| `:Overleaf comment reply` | Reply to the comment thread under the cursor |
| `:Overleaf comment resolve` | Resolve/reopen the comment thread under the cursor |
| `:Overleaf comments` | Refresh and list all unresolved project comments |
| `:Overleaf comments refresh` | Refresh comments from server |
| `:Overleaf history` | View project history |
| `:Overleaf sync` | Sync all documents to/from disk |
| `:Overleaf sync import` | Import external changes from disk to Overleaf |
| `:Overleaf sync export` | Export all documents to disk |

### Native Tree Keymaps

| Key | Description |
|-----|-------------|
| `Enter` | Open document |
| `a` | New document |
| `A` | New folder |
| `d` | Delete |
| `r` | Rename |
| `u` | Upload file |
| `R` | Refresh tree |
| `q` | Close tree |

## Configuration

```lua
require('overleaf').setup({
  -- Path to .env file containing OVERLEAF_COOKIE (default: '.env')
  env_file = '.env',

  -- Session cookie (overrides .env)
  cookie = nil,

  -- Path to Node.js binary (default: 'node')
  node_path = 'node',

  -- Log level: 'debug', 'info', 'warn', 'error' (default: 'info')
  log_level = 'info',

  -- Local file sync directory for external tools like Claude Code (default: nil = disabled)
  -- When set, all documents are mirrored to disk and external changes are synced back.
  sync_dir = '~/.overleaf',

  -- File explorer integration: 'native' or 'canola' (default: 'native')
  -- The canola explorer requires sync_dir.
  explorer = 'native',

  -- Picker integration: 'auto', 'snacks', or 'native' (default: 'auto')
  -- 'auto' uses snacks.picker when available and falls back to vim.ui.select/quickfix.
  picker = 'auto',

  -- Wipe overleaf:// and canola-overleaf:// buffers before Neovim exits.
  -- This prevents session managers from restoring inert virtual buffers.
  cleanup_buffers_on_exit = true,

  -- Compilation backend. The default uses Overleaf's server-side compiler.
  -- Use backend='local' to compile from sync_dir with latexmk.
  compile = {
    backend = 'overleaf', -- 'overleaf' or 'local'
    main_file = nil, -- nil = infer from Overleaf root doc, main.tex, or first .tex file
    local_command = nil, -- default: latexmk -pdf -interaction=nonstopmode -synctex=1 {main}
    local_watch_command = nil, -- default: latexmk -pdf -pvc -interaction=nonstopmode -synctex=1 {main}
    open_pdf = true,
    auto_start_watch = false,
  },
})
```

## Workflow

1. `:Overleaf projects` — authenticate and select a project
2. File explorer appears — press `Enter` to open a document
3. Edit normally — changes sync to Overleaf in real-time
4. `:w` — triggers compile and opens PDF
5. `:Overleaf explorer` — browse the project

## Local Compilation

Overleaf compilation remains the default because it matches the cloud environment exactly. For faster local feedback and PDF viewers that auto-reload, enable local compilation from the synced project directory:

```lua
require('overleaf').setup({
  sync_dir = '~/.overleaf',
  compile = {
    backend = 'local',
    main_file = 'main.tex', -- optional; inferred when omitted
  },
})
```

With `backend = 'local'`, `:w` and `:Overleaf compile` run:

```sh
latexmk -pdf -interaction=nonstopmode -synctex=1 <main-file>
```

You can override the command with a list or shell string. Use `{main}` as a placeholder if the main file should appear somewhere other than the end:

```lua
compile = {
  backend = 'local',
  local_command = { 'latexmk', '-lualatex', '-interaction=nonstopmode', '-synctex=1', '{main}' },
}
```

For live PDF refresh, run:

```vim
:Overleaf compile watch
```

This starts `latexmk -pvc` in the sync directory and opens the generated PDF once. Use a PDF viewer that auto-reloads changed files, such as Skim, sioyek, Zathura, or Okular. Stop the watcher with:

```vim
:Overleaf compile stop
```

To start the watcher automatically after connecting:

```lua
compile = {
  backend = 'local',
  auto_start_watch = true,
}
```

## External Tool Integration (Claude Code, etc.)

By default, Overleaf documents exist only as virtual buffers — they have no files on disk. This means external tools like Claude Code cannot read or edit them.

Set `sync_dir` to enable local file mirroring:

```lua
require('overleaf').setup({
  sync_dir = '~/.overleaf',  -- or any directory
})
```

When connected to a project, all text documents are synced to `~/.overleaf/<project-name>/`. External tools can read and edit these files — changes are automatically detected and synced back to Overleaf. Neovim still edits live `overleaf://` buffers so collaborator updates, cursors, comments, and OT synchronization continue to work normally.

LaTeX LSP servers are started with this synced project directory as their workspace root. Live buffers keep their `overleaf://` names for Overleaf OT/collaboration, but the LSP protocol sees the matching local `file://` URI from the mirror. That lets tools such as texlab index unopened `.tex` and `.bib` files for labels, references, and citations.

### How it works

- **On connect**: all documents are fetched and written to disk
- **Neovim edits**: debounced writes keep disk files up to date
- **Remote edits**: disk files are updated when collaborators make changes
- **External edits**: file watchers detect changes and sync them to Overleaf via OT
  - For open documents: buffer is updated, triggering the normal OT pipeline
  - For closed documents: changes are sent directly via the bridge

### Commands

- `:Overleaf sync` — re-sync all documents (fetch from Overleaf and write to disk)
- `:Overleaf sync import` — import all external disk changes to Overleaf
- `:Overleaf sync export` — export all documents to disk

### Canola explorer

Set `explorer = 'canola'` and `sync_dir` to browse the active Overleaf project with canola.nvim:

```lua
require('overleaf').setup({
  sync_dir = '~/.overleaf',
  explorer = 'canola',
})
```

`:Overleaf explorer` opens a `canola-overleaf://` project view. Selecting a text document opens the live Overleaf document buffer, while file refs are opened from the local mirror. Creating, deleting, and same-folder renaming in that view call the corresponding Overleaf project operations, then refresh the local mirror. Canola refreshes also re-run the Overleaf sync before rendering.

Oil and snacks.explorer adapters are not implemented yet.

### Usage with Claude Code

```bash
# Start Claude Code in the sync directory
cd ~/.overleaf/My\ Project
claude
```

Claude Code can now read all your LaTeX files and make edits that sync back to Overleaf in real-time.

## How It Works

The plugin spawns a Node.js bridge process that connects to Overleaf's real-time collaboration server via Socket.IO. Edits in Neovim are converted to OT operations and sent to the server. Remote edits from other collaborators are transformed and applied to your buffer in real-time.

## Disclaimer

This is an **unofficial** plugin and is not affiliated with, endorsed by, or supported by [Overleaf](https://www.overleaf.com). It relies on Overleaf's internal real-time collaboration protocol, which is undocumented and may change at any time without notice. Such changes could cause the plugin to stop working, or in the worst case, lead to document corruption or data loss.

Overleaf maintains version history for all projects, so you can restore previous versions from the Overleaf web interface if anything goes wrong.

**Use this plugin at your own risk.** Always keep important work backed up.

## Acknowledgments

This project was developed with reference to the following projects for understanding Overleaf's real-time collaboration protocol:

- [AirLatex.vim](https://github.com/dmadisetti/AirLatex.vim) (MIT) — Neovim plugin for Overleaf by David Hartmann. Referenced for Chrome cookie extraction approach and Socket.IO connection patterns.
- [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop) (AGPL-3.0) — VS Code extension for Overleaf. Referenced for protocol details including the v2 connection scheme, OT update hashing, and joinDoc parameters.

The code in this repository is an independent implementation in Lua/Node.js. No source code was directly copied from either project.

## License

MIT
