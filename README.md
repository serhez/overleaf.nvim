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

## Development

Run the Lua, Node synchronization, and bridge integration suites with `make test`.
Run only the synchronization engine tests with `node --test tests/node/sync/*.test.js`.

The document engine under `node/sync/` is not used for normal editing yet. The
editing and mirroring behavior described above still applies. The engine provides:

- Immutable recovery snapshots, revision checks, persisted upload intent, and an
  exclusive writer lock. `SnapshotStore.open(directory)` acquires ownership;
  `close()` drains accepted writes and releases it. Constructing a store directly
  provides read-only recovery access. A crashed writer leaves its lock in place
  for explicit recovery after verifying that the original writer has stopped.
- Separate remote, saved, and unsaved buffer state, merged with Git's file merger.
- Local undo/redo entries rebased against current text. Independent incoming edits
  survive undo; ambiguous overlaps leave text and history unchanged. Identical
  edits made independently by two people may be undone together, once per local
  history entry. Undo does not publish anything until the result is saved.

The editor history adapter in `lua/overleaf/editor/history.lua` captures native
undo trees, including redo and alternate branches. The bridge's
`rebaseEditorHistory({ history, content })` request uses Git to rebase those states
without connecting to Overleaf. A clean response contains the complete rebased
tree; a conflict contains the conflicting inputs and no installable tree.
`install(capture, history, modified)` checks buffer revisions before installing it,
and `dispose(capture)` releases temporary recovery files. The caller must persist
recovery state before installation and supply the disk-related modified flag.

`checkpoint(capture)` exports the text tree, per-state native empty-buffer flags,
native undo bytes, metadata, and editor options (including BOM) for durable
storage. The engine's `checkpointEditor(checkpoint,
revision)` records what Neovim actually displays separately from its reconciled
buffer target. Once attached, native checkpoints own undo; the standalone
`edit`, `undo`, `redo`, `save`, and `resolve` entry points are unavailable for that
document. Native conflict-resolution integration is still required.

`prepareEditorUpdate(revision)` persists a proposal before returning its token,
rebased native tree, exact buffer text (`content`), and ordinary-save text
(`writeContent`, including `fixendofline`). The adapter reports installation through
`acceptEditorUpdate(token, checkpoint)` or a metadata/size hold through
`holdEditorUpdate(token, reason)`. Held revisions and subsequent incoming changes
remain in recovery storage. `saveEditor(checkpoint, revision, content)` requires
the exact text observed on disk at save time, validates it against the captured
ordinary write, and retries against its fresh history. `SAVE_MISMATCH` preserves
engine state and pauses the controller for separate disk reconciliation; custom
write handlers or external writers cannot silently substitute another revision.
Save reconciliation accounts for
incoming text the editor has not yet displayed; checkpoints alone never publish
unsaved text. Restarting with an unconfirmed import holds it for a fresh editor
observation rather than assuming it succeeded.

History rebasing is limited to 1,000 states and 16 MiB of snapshot text. A conflict
or exceeded limit holds the buffer update without truncating history. Supported
histories retain native sequence IDs, timestamps, and file-write markers. The
metadata adapter handles Neovim's version-3 undo files on 64-bit Neovim 0.10–0.12
and limits each native undo file to 64 MiB; unknown layouts are held. Both the
original and candidate imports are checked in a scratch buffer before the live
buffer is changed.

`HISTORY_HELD` leaves the live text and undo tree untouched. One such case is a
current save counter that differs from the last save counter: Neovim cannot
reliably restore that position together with time-based navigation. A normal save
can make the history installable. A retry may remain held if another limit or
conflict still applies; it never forces an update or drops undo history.

The bridge exposes `syncOpen({ root, server, projectId })`,
`syncDocument({ session, document, action, ... })`, and `syncClose({ session })`.
Recovery directories are keyed by normalized server URL and project ID. Document
actions are `open`, `state`, `snapshot`, `remote`, `checkpoint`, `save`, `prepare`,
`accept`, and `hold`; each reply carries its session, document, and revision.
These APIs do not send updates to Overleaf or write project sources. Session close
drains accepted work before releasing the recovery-store writer lock.

`lua/overleaf/editor/session.lua` binds an opened engine document to an ordinary
buffer through `attach(buf, binding, { modified, saved, on_status })`. The workspace
must supply `modified(writeContent)`, comparing the candidate's ordinary-save
text against actual disk state, and synchronous `saved()`, returning the exact
file bytes observed at save time. These callbacks must detect unstable reads and
report failures rather than guess. `TextChanged` and text-related `OptionSet`
events deliver unsaved checkpoints; `BufWritePost` captures native history and
saved bytes immediately, even while a previous request is pending. The `save`
RPC sends those bytes as canonical base64 in `bytes`, then validates UTF-8 before
comparing them with the checkpoint. Incoming
revisions trigger guarded updates, and ordinary saves retry held updates. Captures
of ongoing insert-mode edits and buffer installations wait until insert mode ends
to preserve undo grouping; already captured saves can still be delivered.
`stop()` detaches the controller without deleting its buffer and returns paths to
any unconfirmed recovery captures. Persistence failures pause imports and retain
those captures; obsolete session/document replies cannot change the buffer.

Normal bridge shutdown closes stdin and drains accepted synchronization requests
and recovery writes before reporting the process stopped. Unresponsive network
requests can be abandoned after five seconds; this deadline does not interrupt
recovery writes. New requests and starts receive `STOPPING` while it drains.
Abrupt termination retains recovery locks for explicit inspection.

`node/sync/codec.js` provides `decodeBytes(bytes, options)`,
`decodeText(text, options)`, `editorText(view, { forWrite })`, and
`encodeEditor(view, { forWrite })`. A view contains joined native `content`, an
explicit `empty` flag, and editor `options`. It distinguishes empty files from
blank lines, preserves Unicode, BOMs, LF/CRLF and missing terminal newlines, and
applies `fixendofline` only when describing a write. Encoding tests compare 128
combinations against actual Neovim writes. Invalid UTF-8, NUL, binary buffers,
non-UTF-8 encodings, classic Mac line endings, and mixed DOS/Unix input under DOS
options are rejected. Native history merges use exact text and convert back to
editor lines without changing options; an unrepresentable result remains held
as `text-options`.

`Workspace.open({ root, recovery })` in `node/sync/workspace.js` owns an exclusive
recovery store outside the source tree. Both paths must be absolute; callers
must assign one stable recovery directory to each source root. Its API is:

- `observe(relativePath)`: read twice with content, file identity, metadata, and
  parent-directory checks; persist exact bytes and return a revisioned record.
  It does not change source files or make observations publishable engine saves.
- `write(relativePath, bytes, revision)`: require the recorded source identity and
  contents, durably retain the original and candidate, stage and flush the file,
  recheck the source and writer ownership, then atomically install. Existing
  POSIX mode/owner/group are retained. Creation never overwrites a competing file.
- `snapshot(relativePath)`: inspect durable observations and pending intents.
  An interrupted write blocks further observations/writes for that file until
  explicit recovery; it is never assumed complete or retried automatically.
- `close()`: drain accepted work before releasing recovery ownership.

Source files are limited to 16 MiB. Traversal, symlinked source paths, nonregular
files, and hard-linked files are rejected. Missing sources remain observations,
not instructions to delete remote documents. Two matching reads cannot prove an
external writer has finished, and rename is not a filesystem compare-and-swap:
an uncooperative writer can still race the final check and installation. These
guards assume trusted source directories, not hostile directory replacement.
Directory watching, rescans, explicit write recovery, lifecycle handling, and
the coordinator connecting this adapter to engine/editor revisions remain required.

The legacy editing path does not attach the new controller or workspace adapter
yet. Other remaining integration includes window/selection preservation,
large-history performance, native conflict resolution, and verified transport
encoding and acknowledgements that confirm application rather than queueing.

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
