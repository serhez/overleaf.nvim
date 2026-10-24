# overleaf.nvim

Neovim plugin for collaborative LaTeX editing on [Overleaf](https://www.overleaf.com).

Edit ordinary local files in Neovim and automatically synchronize saved changes with Overleaf. Incoming collaborator edits are reconciled with your saved files, unsaved edits, and native undo history. Conflicts retain each version for review.

## Features

- **Saved-change collaboration** — `:write` saves locally; saved revisions synchronize automatically, while incoming edits preserve unsaved work and local undo
- **Ordinary Neovim buffers** — normal filenames, filetypes, Treesitter, LSP, and snippets
- **File tree** — browse and manage project files in a sidebar
- **Auto-authentication** — extracts session cookie from Chrome or Arc automatically (macOS)
- **Offline editing** — disconnecting keeps local files, buffers, undo, and guarded saves available
- **Compile & PDF preview** — compile LaTeX and open the PDF
- **Comments & reviews** — view, reply, resolve comment threads; open ranges render as diagnostics
- **Collaborator cursors** — see where other users are editing
- **Project-wide search** — grep across all documents
- **Picker integration** — use snacks.picker for project, document, and search result pickers when available
- **File management** — create, delete, rename, upload files
- **History** — view project version history
- **Diagnostics** — chktex linter + LaTeX compile errors via `vim.diagnostic`
- **LSP support** — auto-attaches texlab, ltex, harper_ls to overleaf buffers
- **Ordinary files** — external tools edit the same workspace; reconciliation uses durable baselines instead of exporting cached buffer text

## Requirements

- Neovim 0.10–0.12, 64-bit (unknown native undo formats hold automatic updates)
- Node.js >= 20.18.1
- macOS or Linux with GNU `cp` (for guarded file metadata preservation)
- Git (for three-way text merging; no project repository or Overleaf Git subscription is required)
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
| `:Overleaf status` | Show local-save, remote-sync, and held states |
| `:Overleaf conflicts` | Select a held document or changed binary file |
| `:Overleaf resolve` | Review the current text conflict |
| `:Overleaf resolve history` | Resolve a native undo conflict |
| `:Overleaf resolve disk-history` | Resolve saved persistent undo |
| `:Overleaf recover` | Inspect saved, unsaved, and retained recovery versions |
| `:Overleaf migrate [directory]` | Import a selected legacy file or virtual buffer for review |
| `:Overleaf resolve codediff` | Open optional CodeDiff review |
| `:Overleaf recover locks` | Review a failed project writer lock |
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
| `:Overleaf search [pattern]` | Search downloaded documents, including dirty buffers; without a pattern, open the live search picker |
| `:Overleaf comment add` | Create a comment on the current visual selection |
| `:Overleaf comment show` | Show the comment thread under the cursor |
| `:Overleaf comment reply` | Reply to the comment thread under the cursor |
| `:Overleaf comment resolve` | Resolve/reopen the comment thread under the cursor |
| `:Overleaf comments` | Refresh and list all unresolved project comments |
| `:Overleaf comments refresh` | Refresh threads and owned document ranges |
| `:Overleaf comments drafts` | Inspect retained messages and recover their anchors |
| `:Overleaf history` | View project history |
| `:Overleaf sync` | Reconcile saved workspace files |
| `:Overleaf sync import` | Reconcile saved files; compatibility alias |
| `:Overleaf sync export` | Reconcile saved files without exporting unsaved text |

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

  -- Parent of project workspaces (default: stdpath('data') .. '/overleaf/workspaces').
  -- Each project uses a directory keyed by server and project ID.
  sync_dir = '~/.overleaf',

  -- File explorer integration: 'native' or 'canola' (default: 'native')
  -- Both explorers use the active ordinary workspace.
  explorer = 'native',

  -- Picker integration: 'auto', 'snacks', or 'native' (default: 'auto')
  -- 'auto' uses snacks.picker when available and falls back to vim.ui.select/quickfix.
  picker = 'auto',

  -- Remove clean UI launcher buffers before exit; retain all legacy source buffers.
  -- Ordinary workspace files keep normal Neovim exit behavior.
  cleanup_buffers_on_exit = true,

  -- Compilation backend. The default uses Overleaf's server-side compiler.
  -- Use backend='local' to compile a snapshot of saved files with latexmk.
  compile = {
    backend = 'overleaf', -- 'overleaf' or 'local'
    main_file = nil, -- nil = infer from Overleaf root doc, main.tex, or first .tex file
    local_command = nil, -- default: latexmk -pdf -interaction=nonstopmode -synctex=1 {main}
    open_pdf = true,
    auto_start_watch = false,
  },
})
```

## Workflow

1. `:Overleaf projects` — select a cached project or authenticate to browse remote projects
2. File explorer appears — press `Enter` to open a document
3. Edit normally; unsaved text stays local
4. `:w` saves locally and queues that saved revision for synchronization
5. `:Overleaf compile` compiles explicitly; `:Overleaf status` shows outstanding work
6. When a conflict is reported, use `:Overleaf conflicts` or `:Overleaf resolve`

Incoming changes merge automatically when the text and undo history can both be
preserved. During insert, replace, or selection mode, buffer installation waits
until the interaction ends. Outgoing keystroke-level live mode is deferred.
Project switching retains dirty buffers. Restoring an archived editor after a
restart offers its text and undo, the current file and undo, or cancellation.
Existing project-name mirror directories are retained; they are not silently
adopted into the new identity-based workspace.

## Local Compilation

Remote compilation captures the requested saved inputs and waits up to 15 seconds for their applied acknowledgments. Offline documents, uncertain uploads, conflicts, and binary changes that have not been uploaded stop the request. If a saved file or project metadata changes while waiting, retry compilation. Overleaf does not provide an atomic compile of a specific collaborative revision; colleagues can still change the remote project after these checks.

Overleaf compilation uses the cloud environment. Local compilation also works offline: it captures the saved project files, including binary assets, into a private build directory before starting the compiler. Unsaved buffer edits stay out of the build, and later saves cannot change that build's inputs. Build inputs are limited to 256 MiB in total; missing files or unresolved project paths must be addressed before compiling.

```lua
require('overleaf').setup({
  sync_dir = '~/.overleaf',
  compile = {
    backend = 'local',
    main_file = 'main.tex', -- optional; inferred when omitted
  },
})
```

With `backend = 'local'`, `:Overleaf compile` runs:

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

Watch mode checks saved inputs every two seconds and runs the same one-shot `local_command` when they change. Builds run sequentially, each from its own snapshot. A successful build updates a stable PDF path for viewers that reload changed files. The `local_watch_command` option is rejected; use `local_command` to configure both manual and watched builds. Stop the watcher with:

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

Downloaded PDFs and file previews use a single validated filename within the selected output directory. Downloads are staged privately and replace an existing regular file only after a complete response and a check that the destination has not changed. Failed or empty downloads retain the previous file. Symlink and hard-link destinations are refused. Downloads are limited to 64 MiB; synchronized assets and compile logs are limited to 16 MiB. Overleaf cookies are sent only to the configured server origin, including when following redirects or retrieving compile logs.

## External Tool Integration (Claude Code, etc.)

Documents are ordinary local files. Editors, language servers, and command-line tools can read and edit them directly. Set `sync_dir` to choose the parent directory for project workspaces:

```lua
require('overleaf').setup({
  sync_dir = '~/.overleaf',  -- or any directory
})
```

Each workspace uses a hash of the server and project ID, so projects with the same display name remain separate. The default parent is `stdpath('data')/overleaf/workspaces`. Native filenames and `file://` URIs work normally; opening files or starting an LSP does not save unsaved edits.

### How it works

- **On connect**: project metadata and sources are reconciled with retained local state. New files download in the background without opening buffers.
- **Neovim edits**: typing stays unsaved until a normal write. Saved revisions upload automatically while connected.
- **Remote edits**: independent changes update source files and rebase local undo history; conflicts pause the affected update for review.
- **External edits**: directory watches and periodic rescans reconcile saved file changes. Unsaved editor text remains a separate branch.
- **Offline editing**: `:Overleaf projects` offers cached projects before authentication. Downloaded documents and the explorer remain available. A network disconnect keeps local save ownership.
- **Project changes**: folder moves, renames, deletions, and replacement IDs update the project metadata. Source updates at changed paths remain held for lifecycle review; local files and dirty buffers are retained.

### Commands

- `:Overleaf sync` — reconcile project sources and saved changes
- `:Overleaf sync import` / `export` — compatibility aliases for reconciliation; neither writes unsaved buffer text

### Canola explorer

Set `explorer = 'canola'` and `sync_dir` to browse the active Overleaf project with canola.nvim:

```lua
require('overleaf').setup({
  sync_dir = '~/.overleaf',
  explorer = 'canola',
})
```

`:Overleaf explorer` opens a `canola-overleaf://` project view. Selecting a text document opens its ordinary file buffer. Project operations update the remote tree and reconcile local state; remote deletion does not delete the retained local source.

Oil and snacks.explorer adapters are not implemented yet.

### Usage with Claude Code

Open a project source and use `:echo expand('%:p')` to locate its workspace.
Start your external tool in that directory. Changes it writes to known text files
are reconciled and uploaded while connected. Unsaved Neovim text stays separate.
New local files require an explicit upload; deleting a local file does not delete
its Overleaf counterpart.

## How It Works

The Lua coordinator attaches ordinary buffers to a Node.js synchronization engine. The engine retains separate server, saved-file, and unsaved-editor branches. Git's file merger reconciles text; verified native undo imports preserve local history. Saved revisions use Overleaf's Socket.IO operation protocol. Incoming updates arrive through that connection; filesystem watches and three-second rescans detect external saved changes. There is no separate Lua upload queue or mirror writer.

## Conflicts and undo

Independent incoming edits appear automatically after the current insert or
selection interaction ends. `u`, redo, and alternate undo branches affect your
edits against the updated text. If both people independently made the same edit,
undo can remove that shared text once for the corresponding local undo entry.
Undo does not publish anything until you save.

Use `:Overleaf conflicts` to select a held file, or `:Overleaf resolve` in its
buffer. Edit the result pane and `:write` each choice: saved text first, then
any overlapping unsaved edits and undo states. Partial choices are retained.
Changed source text or a newer server revision invalidates an old review.
`resolve history` and `resolve disk-history` review live and persistent undo
separately. `<leader>q` closes a text review; edited drafts must be retained.

A remote rename requires explicit path acceptance. The plugin copies saved
bytes to the new path, retains the original file, and keeps the same buffer and
undo tree. Deleted or replaced identities offer keeping the source local only
or retaining it at a separate `.local-<identity hash>` path. Binary reviews offer
explicit local/remote choices and never text-merge bytes.

Ordinary `:write`, `:update`, and save-and-quit commands use guarded local saves.
Alternate-target, partial, append, and `++` writes are unsupported on attached
sources. `:w!` does not bypass a changed disk file or unresolved write recovery.
The local bridge is required for guarded saves; an Overleaf connection is not.

## Comments, cursors, and search

Comment highlights and collaborator cursors are projected from Overleaf's UTF-16
positions into native UTF-8 byte columns, accounting for unsaved buffer edits.
Comment ranges follow incoming operations and refresh after editor changes
(coalesced over 75 ms). Cursor events have no document version; they are mapped
against the latest received snapshot and then follow native extmarks until the
next event. A response for an older buffer view or project is ignored.

Creating a comment retains its message and anchor before posting. The selected
text must already exist on the server; unsaved changes outside the selection
are allowed. If the selection itself is unpublished, save and synchronize it
first. Posting a comment never saves or uploads the surrounding unsaved buffer.
Anchors share the saved-text operation queue and require an applied server
acknowledgement. A queue receipt alone does not complete the comment.

If the HTTP response is lost, `:Overleaf comments drafts` retains the message
and selected text. Press `c` to inspect the existing server thread without
posting again. If the message is confirmed, its anchor can continue syncing.
A reconnect without enough history to track an unsent anchor holds it: select
the desired source text, reopen the drafts view, and press `a` to reattach.
An unconfirmed message remains available to copy and inspect in Overleaf.
Closing the view retains the draft. At most 32 outstanding drafts per document
and 1 MiB per message are accepted.

Search reads open native buffers, including unsaved edits, and saved snapshots
of downloaded background documents. Unavailable documents are skipped and
reported by pattern search. Search and comment refresh do not join or leave
documents, change subscriptions, or export buffers. Their workspace identity
includes the server and project, so equal project IDs on different servers
do not share search state.

`editor.session.attach`, `restore`, and `use_current` accept an optional
`on_change(controller)` callback after a completed reconciliation cycle. The
workspace uses it to refresh projected comment positions.

## Final editor captures and ordinary-file tools

Closing a project or exiting Neovim freezes native edits that have not reached
the scheduled checkpoint. Captures for ordinary project files live in the
private `editor-captures` directory under that project's recovery directory;
the snapshot, undo file, and directory are flushed before returning. This does
not save the source or publish unsaved text. An abrupt operating-system kill
of Neovim itself can still lose edits that it had no opportunity to capture.

`:Overleaf recover` includes retained captures for the current document,
including captures from previous editor sessions. Select a capture and press
`p` to restore its text as an unsaved, undoable local edit. The current undo tree
and original capture remain available. Typing or synchronization after opening
the review invalidates acceptance; open a fresh review in that case. The view
limits capture previews to 64 entries and 16 MiB of text. Retained artifacts
are not deleted when the view closes.

Ordinary source buffers retain native file identity, filetypes, and user
options. After successful attachment, the plugin starts available Treesitter,
LSP, and chktex integrations. Reopening the same buffer does not duplicate
setup. Lint requests debounce independently per buffer, and results are ignored
if the buffer, workspace, or request has changed. Tool startup never exports
source content or replaces native undo history.

Remote compile requests allow up to 90 seconds for saved-revision confirmation,
server compilation, and log retrieval. Individual network phases retain their
own time limits.

## Optional CodeDiff review

Use `:Overleaf resolve codediff`, or press `<leader>c` in a native text/history
review, to open the installed CodeDiff plugin. The adapter creates a private
repository containing only the base, local, and remote index stages. It has no
commits or remotes and does not modify the project's Git index. The original
marked candidate remains in a separate file under the project's `merge-views`
recovery directory.

Saving in CodeDiff imports the exact saved bytes into the native result pane.
Return there and `:write` to accept the choice through the normal revision and
undo-history checks. Saving or staging in CodeDiff alone does not resume sync.
If the native draft or review changes, the external draft remains available
without replacing it. Draft files are retained when views close.

The native view remains available if CodeDiff is missing, the base is unknown,
or Git environment overrides could redirect CodeDiff to another repository.

## Unknown upload outcomes

If reconnecting cannot prove whether a saved operation was applied,
`:Overleaf resolve` opens a read-only view of its original base, exact submitted
text, current saved and unsaved branches, and a freshly joined server snapshot.
The operation is not retried merely because its text appears on the server.

When the original successful queue receipt was durably recorded and the server
supports a queue-draining join, press `a` to retain the old intent as evidence
and open an ordinary text conflict. Acceptance fetches another fresh snapshot;
changed inputs reject the decision. Return to the source and run
`:Overleaf resolve` to choose saved text, unsaved text, and historical states.
Retiring the uncertain intent does not accept text or send another operation.

Without both the queue receipt and the queue-draining contract, the intent
stays held. Its versions remain readable and can be copied from the review.
A matching snapshot, an untyped server response, or a missing operation in
truncated history cannot authorize a resend. Comment anchors from a retired
intent also stay held until explicitly reviewed and reattached.

Press `l` in this review to keep the file local only. Its ordinary source file,
current unsaved edits, undo history, and original upload intent are retained.
No further edits to that document will be uploaded. This choice does not claim
that the original submission failed: it may already be present on Overleaf.

## Source directory ownership

Each source directory contains `.overleaf-workspace.json`, which binds it to
its recovery directory. Keep this file with the sources. A second recovery
location, a different project, or an overlapping parent/child workspace cannot
adopt the same files. Changing or removing the record stops guarded source
operations. This reserved filename cannot be used as a project document.
The ownership inventory follows ordinary directories, ignores symlinks, and
holds opening if it exceeds 100,000 entries.

## Legacy migration

Open the destination project, then use `:Overleaf migrate /old/project/directory`
to inventory old files. `:Overleaf migrate` without a directory lists loaded
`overleaf://` buffers. Select the legacy source and then a destination document;
the destination prompt shows its server and project ID. Project display names
never establish identity. Links and nonregular files are listed but cannot be
imported. Inventories are limited to 10,000 entries; selected text is limited to
16 MiB and must be valid UTF-8 without NULs.

Migration retains the original file or virtual buffer. It records the selected
text and origin as an independent branch with no assumed common ancestor.
Current saved text, unsaved edits, and native undo stay intact. Use
`:Overleaf resolve` to review the imported branch alongside the saved file and
server head, then resolve any unsaved or historical overlap. Nothing is saved
or uploaded merely by importing. Files changed after selection and destinations
with unresolved work are refused.

## Recovery limits and retention

The latest 32 committed snapshots per document are retained. Current manifests
contain complete native history, pending upload intents, conflicts, and recovery
evidence; those are not trimmed by snapshot retention. Uncommitted or otherwise
unreferenced objects are retained because their outcome may be unknown. Cleanup
failures retain the affected objects and report a warning.

Local compilation keeps the latest ten completed private build directories.
Active builds and builds whose completion was not confirmed, including after a
crash, remain available. One-shot PDF paths belong to these retained builds;
watch mode publishes a separate stable PDF path.

If native history exceeds the automatic limit, or text cannot be rebased,
recovery retains `buffer.txt`, `snapshot.json`, and any exported `original.undo`.
`buffer.txt` contains the native UTF-8 bytes with LF separators, including NULs
when present; editor options are recorded separately in `snapshot.json`.
A failure to finish or flush this capture is reported explicitly.

`:Overleaf recover` shows the current native text, saved/remote versions, retained
captures, and the editor error. Press `e` to export the selected version to a new
file; an existing file or link is refused. This neither accepts a recovery choice
nor saves or publishes the source. Correct unsupported buffer options before
resuming; oversized native history remains held and is never silently discarded.

## Development


Run the Lua, Node synchronization, and bridge integration suites with `make test`.
Run only the synchronization engine tests with `node --test tests/node/sync/*.test.js`.
Install bridge dependencies with `npm install --prefix node` first. The grouped
Lua suites have a three-minute deadline per file; operation-level deadlines
remain independent. Metadata
tests use the native macOS tools, or Python 3 and the `acl` package on Linux.
CI runs the full suite on Linux and macOS with Neovim 0.10.4, 0.11.5, and stable;
the additional nightly job reports compatibility changes without blocking releases.
The workspace tests use disposable files and headless Neovim processes to check
multi-buffer saves, save-and-quit behavior, durable saved contents, and reopening
after process exit.

<details>
<summary>Synchronization APIs and implementation</summary>

The document engine under `node/sync/` owns normal editing and provides:

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

`record_save(currentCapture, writtenCapture)` records an acknowledged local save
when newer edits prevented native write completion. It imports only save-marker
metadata, verifying original and candidate histories in a scratch buffer first.
The written states must still exist unchanged, the saved state must be an
ancestor of the current state, and the native save position must be restorable.
Unsupported cases raise `HISTORY_HELD`; callers retain both recovery captures.

`checkpoint(capture)` exports the text tree, per-state native empty-buffer flags,
native undo bytes, metadata, and editor options (including BOM) for durable
storage. The engine's `checkpointEditor(checkpoint,
revision)` records what Neovim actually displays separately from its reconciled
buffer target. Once attached, native checkpoints own undo; the standalone
`edit`, `undo`, `redo`, `save`, and `resolve` entry points are unavailable for that
document. Native conflict views resolve saved, unsaved, and historical overlaps separately.

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

`node/sync/ot.js` validates text operations, produces Unicode-boundary edits,
transforms concurrent operations, and translates native byte columns to server
UTF-16 offsets. It rejects mismatched delete/comment payloads, invalid bounds,
split code points, and unsupported components before applying changes. Transform
results are checked for convergence. Limits are 4,096 components, 16 MiB results,
and one million input component pairs per transform; exceeding them requires
reconciliation, never truncation.

The underlying text transform is the MIT-licensed Overleaf ShareJS implementation,
vendored unchanged from [Overleaf's pinned source](https://github.com/overleaf/overleaf/tree/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/sharejs)
with its license in `node/vendor/sharejs/LICENSE`. Saved diffs
use the BSD-licensed [jsdiff](https://github.com/kpdecker/jsdiff) implementation,
first by line and then by Unicode code point within changed blocks. Unchanged
spans are retained. Diff work is bounded to 100 ms, 4,096 edit steps per pass,
200,000 combined input line separators, and 262,144 code units per changed
character block; exceeding a bound holds the upload without replacing a larger
span as a fallback.

`node/sync/transport.js` coordinates one saved-change stream on one connection.
It persists the exact operation and connection source before sending. A queue
callback cannot confirm application: only the matching operation-less applied
event at the current pre-increment version acknowledges the save. Concurrent
operations transform the pending save; later saves wait behind it. Version
gaps, malformed operations, disconnects, and join-buffer overflow hold publication.
Snapshot and range text are decoded from the server's Latin-1-wrapped UTF-8;
ordinary operations already contain Unicode. Unsupported document types are
rejected without replacing local text.

Disk and undo snapshots retain physical UTF-8 text, including BOMs and CRLF.
Remote snapshots additionally retain exact logical server text. Operations and
reconnect proofs use that logical text; incoming revisions are projected into
the saved file's format before reconciliation. The saved revision's format is
tracked separately from newer unsaved buffer options. Changing only BOM or line
endings saves locally without sending an operation or advancing the server
version. Existing server BOMs are tracked independently of local BOM settings.
Mixed line endings, literal carriage returns, and ambiguous old baselines are
held rather than silently converted.

On reconnect, complete operation history can prove a lost acknowledgement by
replaying from the persisted base, finding exactly one matching connection
source, verifying its transformed operation, and reproducing the joined snapshot.
The proof and original intent are retained before another save is sent. Matching
text alone, missing history, or a missing source leaves the outcome uncertain;
the plugin does not automatically resend it. There is one additional proof of
nonapplication: a durable queue receipt followed by a typed ShareJS join, which
drains queued updates before returning complete history. If that history contains
no matching operation, the engine records nonapplication and reconciles a fresh
submission against the joined version. Untyped joins and missing queue receipts
cannot establish this proof.

The verified legacy server sanitizes supplementary Unicode code units inside
insertions, including valid emoji pairs. Such insertions are held as
`unsupported-insert` before creating a network intent; local saves retain the
original text. BMP Unicode and edits around unchanged supplementary characters
remain supported. Incoming revisions continue while this upload is held, and a
later supported save retries automatically. This restriction follows the
[server's insertion handling](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/UpdateManager.js).

History rebasing is limited to 1,000 states and 16 MiB of snapshot text. A conflict
or exceeded limit holds the buffer update without truncating history. Histories
are merged in batches of at most four Git processes, with repeated
text states reused and results checked in sequence order. The full tree is
required before installation; conflicts never expose a partially rebased tree.
Supported histories retain native sequence IDs, timestamps, and file-write markers. The
metadata adapter handles Neovim's version-3 undo files on 64-bit Neovim 0.10–0.12
and limits each native undo file to 64 MiB; unknown layouts are held. Both the
original and candidate imports are checked in a scratch buffer before the live
buffer is changed.

Incoming buffer updates preserve unchanged spans within edited lines, including
Unicode byte positions. Cursors, preferred columns, scroll views, and named
selection marks are mapped independently for every window showing the file;
unaffected extmarks use Neovim's native text-update behavior. Historical edit
cursors are mapped into each rebased parent state, including alternate branches.
Manual folds and jump destinations follow native line adjustments. A failed native
import restores the original views and marks along with the text and undo tree.
Character diff work is limited to 262,144 changed bytes per block and 4,096 edits;
exceeding those limits holds the update before touching the buffer. Common
prefixes and suffixes do not count toward the changed-block limit.

Buffer installation waits until insert, replace, Visual, or Select mode ends.
Incoming revisions remain retained during the interaction and are applied on
return to normal mode. This preserves an active selection and local undo group.

`history.saved_undo(capture, advance)` prepares persistent undo bytes from a
frozen save capture, even if the live buffer has newer edits or has closed.
`advance` explicitly selects whether to add native save-completion metadata;
use `false` for a clean repeated save or an already-finalized capture. The export
preserves the captured text, branches, IDs, and timestamps, and verifies native
import and every undo state in a scratch buffer. It returns `nil` when there is
no captured history. It only writes private verification files; the guarded
write RPC can publish the returned bytes with the source save. Incoming updates
use `history.rebase_saved(checkpoint, bytes, history)` to verify and rebase the
saved archive in private buffers. It returns a native checkpoint and encoded
undo bytes without changing live text or adding save markers.

`history.saved_artifact(capture, advance)` prepares the checkpoint and encoded
bytes used by ordinary guarded saves. It normalizes the saved current state's
final empty line to native readback and accounts for empty-file hash differences,
so native reopening loads the history without changing source bytes or the live
buffer. Other undo states keep their original native lines. As with native undo,
newline options belong to the reopened buffer, not individual historical states;
a change consisting only of the final newline can therefore become a text no-op
in reopened history. Branches, sequence IDs, timestamps, and save markers remain.

The controller honors `undofile` and Neovim's `undodir` selection, freezing the
selected destination after pre-write hooks. Changes to those options during the
write raise `SAVE_CHANGED`. Changing destinations preserves the old archive;
disabling persistent undo (`undo: null` in the RPC) stops publication while
retaining existing archives and recovery snapshots. Empty `undodir` selects no
publication. Reserved archive paths cannot become another document's source.

`HISTORY_HELD` leaves the live text and undo tree untouched. One such case is a
current save counter that differs from the last save counter: Neovim cannot
reliably restore that position together with time-based navigation. A normal save
can make the history installable. A retry may remain held if another limit or
conflict still applies; it never forces an update or drops undo history.

The bridge exposes `syncOpen({ root, server, projectId, sourceRoot? })`,
`syncDocument({ session, document, action, ... })`, and `syncClose({ session })`.
`syncConnect({ session, document })` attaches an opened document to the active
socket after verifying server and project identity. Local writes complete
independently of network joins and queue callbacks. Transport mutations share
the document's transaction queue; applied events cannot interrupt a disk save.
Subscriptions start before joining, old connections are detached, and close
drains accepted persistence without waiting for network replies. Legacy uploads
and leave requests are refused for a document owned by this transport. Replies
include `state.transport`; `syncChanged` events carry transport status changes.
Recovery directories are keyed by normalized server URL and project ID. Without
`sourceRoot`, sessions only update recovery state. With it, the session owns a
local workspace outside its recovery directory; `open` binds a document ID to a
relative `path`. Existing files without a shared baseline are preserved as an
independent local branch. Missing previously bound files hold synchronization.

Document actions include `open`, `state`, `snapshot`, `remote`, `checkpoint`, `save`,
`write`, `prepare`, `accept`, `hold`, `scan`, `diskState`, `writeDiskUndo`, and
`holdDiskUndo`, `recoverDisk`, `prepareReattach`, `acceptReattach`, `useEditor`,
`prepareHistoryResolution`, `prepareConflictResolution`, and
`prepareDiskUndoResolution`. Each reply carries
its session, document, and revision. Workspace replies also include the source
binding and `state.disk`, containing the disk baseline, pending intent, and hold.
Directory notifications and three-second rescans trigger reconciliation; events
are hints and actual content determines changes. `scan` reconciles disk state;
`diskState` inspects the actual file and recovery record without resolving an
interrupted write. Sessions remain offline until `syncConnect`. Session close
drains accepted work before releasing writer locks.

`syncInspectLocks({ root, server, projectId })` reads both project and workspace
ownership without opening a writer. `syncRecoverLocks({ review })` explicitly
releases only reviewed, stopped local processes, rechecking every owner first.
Running processes, foreign hosts, unreadable metadata, and unrecognized lock
formats remain blocked. Locks use nonempty directories so competing recovery
attempts cannot replace a newly acquired writer. Recovered lock records remain
in the recovery directory; document snapshots and source files are untouched.
`require('overleaf.conflicts').locks(params, opts?)` opens this read-only review;
`a` accepts recovery and `q` closes. `opts.on_recovered` can resume project opening
after confirmation. Failed or stale reviews never resume it.

The Lua project coordinator exposes `sync.open_workspace(options, callback)`,
`sync.open_document(entry, opts, callback)`, `sync.reconcile(callback)`, and
`sync.close_workspace(callback)`. Default source directories use normalized
server/project identity; `root` and `sourceRoot` can select separate recovery and
source locations. The bridge's read-only `syncLocate` supplies that identity,
and `syncOpen` returns durable source bindings for offline reopening. Opening
nested sources creates checked ordinary parent directories. Closing or switching
ownership detaches controllers and retains dirty buffers and native undo.
The import/export compatibility commands request disk reconciliation and require
an active workspace.
`open_document` accepts `background = true` to subscribe and reconcile without
creating a buffer or importing archived unsaved text. Background reconciliation
also prepares and installs persistent undo in private buffers. Public document
opening requires the coordinator; disconnecting retains
its local bridge, ordinary buffers, and guarded saves. Connection-handler refresh
preserves workspace and editor subscriptions.

`sync.sync_tree(tree, callback)` reconciles documents in the background and
fetches binary assets through guarded writes. `syncProject` persists bounded
project metadata for offline reopening. Binary RPCs `syncFetchAsset` and
`syncAsset` retain exact bytes and separate remote/local baselines; they never
infer a binary upload from a local change. Downloads are bounded to 16 MiB and
must complete before source installation. Independent local files, missing known
files, divergent bytes, and interrupted writes remain held. Binary review uses
`:Overleaf conflicts`; `l` explicitly keeps the inspected local file and `r`
chooses the reviewed remote bytes. Hex previews are bounded; complete versions
remain in recovery storage. Stale reviews cannot replace newer files.

Reopening an archived editor offers restoring its text and undo, keeping the
current file and undo, or cancelling. Keeping current uses `useEditor` with a
fresh source observation and retains the displaced archive. An independently
dirty preexisting buffer attaches as a separate unresolved branch; its contents
are never inferred to be a saved revision. `editor.use_current` performs that
attachment without importing or clearing native history.

`lua/overleaf/editor/session.lua` binds an opened engine document to an ordinary
buffer through `attach(buf, binding, opts)`. A workspace binding supplies guarded
synchronous file observations automatically. Without a workspace, callers must
provide `modified(writeContent)` and `saved()` callbacks for disk comparison and
exact save-time bytes. `on_status` is optional. Existing native checkpoints need
explicit recovery before attaching another editor. `editor.restore(buf, binding,
opts)` restores a reviewed archive after reopening the project. The bridge first
persists both the current buffer checkpoint and the archived target; native
verification precedes replacement. `history.restore` preserves all archived
text states, branches, IDs, timestamps, and save markers, with Neovim's normal
reopen normalization of the current save counter. Failed imports restore the
prior live capture or retain recovery files if rollback cannot be verified.
`acceptReattach` accepts only the prepared graph/options and token. New editor
observations invalidate that token; remote updates received during restoration
remain pending for reconciliation. An explicit retry retains the interrupted
proposal. Reattachment does not save or publish recovered unsaved text.

For workspace buffers, `BufWriteCmd` performs a guarded local save and waits for
durable completion before returning. The `write` RPC carries a frozen native
`checkpoint`, the expected disk text in `expected`, and the engine `revision`.
The codec derives exact bytes; the engine retains the checkpoint, original, and
candidate before source installation. Failed or uncertain completion preserves
recovery data and does not mark the buffer saved. The older `save` action is
rejected for workspace sessions; without a workspace it still records validated
save-time bytes supplied as canonical base64.

The `write` RPC optionally accepts `undo: { path, bytes, checkpoint }`, where
`checkpoint` describes the verified readback history and `path` is an
absolute destination with ordinary, existing directory parents and `bytes` is
canonical base64 from the verified native export. A history-free checkpoint
requires `bytes: null`. The bridge checks the native content hash and line count
against the frozen checkpoint before saving. The workspace records both original
and candidate files before replacing the source, records source completion, and
then installs the undo file. New and replaced undo files use mode `0600`.
Unrelated files, links, shared document destinations, and externally replaced
tracked undo files are rejected. Empty history removes an obsolete undo file
only after preserving it in recovery.

Configured `backup` and `patchmode` copies are installed before source replacement.
The controller honors `backupdir` (including relative directories and `//` names),
`backupext`, and `backupskip`. A retained backup contains the preceding disk
revision; an existing patchmode original stays untouched. Both copies may exist
on the first save. Backup files use private permissions (`0600`). Their previous
contents and completed stages are recorded in the write intent alongside source
and undo data. A backup failure holds the save with recovery evidence.
`writebackup` protection comes from the durable recovery snapshots; source writes
use staged replacement, regardless of `backupcopy`, and reject linked sources.
The RPC carries these copies as `backups: [{ path, once }]`, with at most two
unique absolute destinations. `once: true` preserves an existing original.
Backups cannot overlap source, undo, or recovery files, or another document's
reserved destinations.

The two replacements are not atomic together. A failure can leave the source
saved while undo publication remains incomplete; the RPC reports
`WRITE_UNCERTAIN` and retains both versions and the last confirmed stage.
Restart never silently retries or assumes completion. Once persistent undo is
tracked, source replacements require the corresponding undo artifact. Clean
source saves can still update undo without replacing the source inode.

The workspace retains the saved checkpoint independently of live undo history.
Incoming reconciliation through `prepare` or `scan` can return `undo-required`
with a token, the saved checkpoint and native bytes, and the proposed rebased
history. The controller verifies the archive in Neovim and submits
`writeDiskUndo({ token, revision, checkpoint, bytes })` before importing the live
buffer update. Saved bytes account for `fixendofline`, BOM, and LF/CRLF. This
works even when undo joining has removed the saved state from live history.
Historical conflicts hold the update without discarding any branch.

`require('overleaf.conflicts').resolve(session?)` opens native diff panes for a
document conflict. Edit the result and use `:write` to accept each choice: the
saved revision, any overlapping unsaved edits, then any conflicting undo states.
Only the completed, verified tree is installed. Saved text remains separate
from unsaved buffer text, and every sequence and branch is preserved. Disk,
current server text, and the original conflict are available in read-only panes
through `<leader>d`, `<leader>s`, and `<leader>b/l/o`; `<leader>r` returns to the
result. A candidate merging cleanly is still reviewed explicitly.

`conflicts.history(session?)` resolves a held live undo-tree conflict;
`conflicts.disk_history(session?)` resolves the independent saved undo archive.
The latter verifies and publishes source plus persistent undo before the live
buffer resumes reconciliation. If both histories conflict, each requires its
own choices. Partial accepted choices are retained durably. Opening a complete
retained draft previews it; a further `:write` confirms installation. `<leader>q`
closes a review and refuses to discard an edited result. These views use native
diffs and do not need a project Git repository.

The controller exposes `review_conflict`/`resolve_conflict`,
`review_history`/`resolve_history`, and
`review_disk_history`/`resolve_disk_history`. Each review freezes the engine
revision and native checkpoint. Stale typing, source changes, or new server
revisions prevent acceptance. Unknown upload outcomes and incomplete disk
transactions must be recovered first. Historical choices are keyed by native
sequence ID and may replace only conflicting states, never clean states or tree
structure. The preparation RPCs retain decisions and issue guarded proposals;
`accept` or `writeDiskUndo` performs the corresponding confirmation. Persistent
proposals requiring review cannot be published by background refresh.

A native rejection uses `holdDiskUndo({ token, reason })`, where `reason` is
`undo-metadata` or `history-limit`. It cancels only an uninstalled preparation;
ordinary saves can supersede such preparations too. Newer targets invalidate
stale proposals, and an intervening source edit triggers fresh reconciliation.
Partially installed writes and preparations found after restart require
recovery. Archives without a saved checkpoint are held for recovery as well.

`require('overleaf.conflicts').recovery(session?)` opens a local recovery review
for the current attached workspace buffer. Read-only panes show current disk,
original disk, saved/remote branches, the interrupted candidate, and retained
captures. The summary includes confirmed source installation and current artifact
observations or read errors. Opening or closing it never changes source text.
Press `a` to explicitly adopt the inspected current disk as the new baseline;
then save the source buffer to continue. The live text and its undo stay intact,
and retained capture files remain available. `r` opens a fresh review and `q`
closes the review. Stale reviews fail without applying or retrying a decision.

The controller APIs `session:inspect()` and `session:recover_disk(review)` back
this flow. `recoverDisk({ revision, choice: 'keep-current', inspection })` checks
the engine revision, workspace revision, and exact current file observation.
It records the old baseline and interrupted intent, retires undo publication
until another ordinary save, and reconciles the adopted disk branch. It never
installs the candidate, removes old artifacts, recreates a missing source, or
settles an uncertain network upload. Restore a missing file before adopting it.
A successful source write whose response was lost can be reviewed the same way.

Workspace save behavior and current limits:

- Pre-write hooks run once; their formatting is included in the saved snapshot.
  Post-write hooks run once after local completion. Callbacks that change text
  or text options during or after writing leave the newer buffer dirty and
  raise `SAVE_CHANGED`, preventing `:x` or `:wq` from closing it. The captured revision
  can already be saved on disk when this error is reported.
- `:wall` saves bound documents independently. A blocked later write leaves
  earlier completed saves intact; it does not roll back the whole project.
  `:x` skips writing a clean buffer, while `:wq` performs the write.
- Saves preserve the buffer's listeners, marks, and native history. Formatting
  an initially clean buffer uses an intercepted native completion step that
  finalizes undo flags and save markers without another disk write or hook run.
  Other recursive saves are rejected. A removed or disabled write handler
  prevents completion and retains recovery data.
- Clean repeated saves do not advance native save counters. Hooks must not
  depend on finalized counters inside `BufWritePost`, since native finalization
  can occur after that hook returns.
- If newer edits interrupt native completion after a confirmed disk write, the
  controller records one marker on the committed snapshot for `:earlier 1f` and
  `:later 1f`. Existing branches, timestamps, positions, and text are preserved.
  If callbacks altered or removed the captured history, switched away from its
  branch, or left an unsupported undo position, syncing pauses with
  `HISTORY_HELD` and retains both captures. The disk save remains committed.
  As in native Neovim, saves at the undo root advance the counter without a
  header marker for file-based navigation.
- Undo/redo checks ordinary-write bytes against a stable disk read and corrects
  `modified` synchronously, before a following command can discard the buffer.
  This includes history navigation after `SAVE_CHANGED`, incoming merges, and
  hook failures. Unreadable sources or unsupported text options leave it dirty.
  Checks remain active while syncing is paused and stop on detachment.
- Unreconciled external changes block saving, including `:w!`. Partial writes,
  appends, alternate targets, and `++` write overrides are unsupported. Readonly
  files/buffers are rejected. Existing custom write handlers prevent attachment.
- The controller disables native `autoread` while attached and handles
  `FileChangedShell` through reconciliation, preserving local-only undo.
  Detaching restores the previous `autoread` setting.

`TextChanged` and text-related `OptionSet` events deliver unsaved checkpoints;
only saved snapshots become publishable. Incoming revisions trigger guarded
updates. Captures of ongoing insert-mode edits and buffer installations wait
until insert mode ends to preserve undo grouping. `stop()` detaches the
controller without deleting its buffer and returns paths to unconfirmed recovery
captures. Persistence failures pause imports and retain those captures; obsolete
session/document replies cannot change the buffer. Workspace saves require the
local bridge, but do not require an Overleaf network connection.

An unexpected disconnect retries with exponential backoff, up to five attempts.
Returning focus to Neovim or resuming a suspended editor retries an offline project
after that batch is exhausted. Manual disconnection remains offline.

Authentication and API HTTP responses are limited to 16 MiB. GET and DELETE
requests have a 15-second total deadline, JSON POST requests 30 seconds, and
multipart uploads 60 seconds. These deadlines include connection and response
transfer time; a peer sending occasional data cannot extend them. Interrupted
responses fail with `RESPONSE_INTERRUPTED`, oversized responses with
`RESPONSE_TOO_LARGE`, and expired deadlines with `REQUEST_TIMEOUT`.
Socket handshakes use the same response bounds and are cancelled on disconnect.
The internal `httpGet(url, cookie, { headers, signal })` helper accepts explicit
handshake headers and an `AbortSignal` without changing the ordinary GET defaults.

Synchronization notifications are hints to reread durable document state. When
Neovim stops consuming bridge output, repeated hints retain only the latest value
per session and document. RPC replies and ordered remote operations are preserved.

Normal bridge shutdown closes stdin and drains accepted synchronization requests
and recovery writes before reporting the process stopped. Unresponsive network
requests can be abandoned after five seconds; this deadline does not interrupt
recovery writes. New requests and starts receive `STOPPING` while it drains.
Comment posts and upload reviews can abandon their network wait while their
already accepted local work finishes. Unconfirmed comments retain their durable
drafts for explicit inspection; shutdown never repeats an uncertain post. The
process remains alive until recovery stores close, even if an unresolved network
request has no open socket.
On final Neovim exit, `VimLeavePre` closes bridge input and waits for the bridge
to finish accepted work and close its recovery stores. Slow storage can delay
exit; a waiting message appears instead of terminating an unfinished write.
Once final exit begins, queued response, timeout, event, and reconnect callbacks
do not resume editor work, and later exit hooks cannot restart the bridge.
Ordinary `bridge.stop()` remains asynchronous and allows a restart after draining.
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
recovery store outside the source tree. Both paths must be absolute. The source
ownership record enforces one stable recovery directory per root and refuses
overlapping roots. Its API is:

- `bind(relativePath, documentId)`: persist exclusive path/document ownership;
  implicit document renames and duplicate ownership are rejected.
- `reviewRelocation(documentId, target)` / `relocate(review)`: inspect, then
  explicitly copy a source and transfer its binding. Recheck source, target,
  metadata and ownership before publication; retain the original file and undo
  archive. Interrupted copies require a fresh review. A persisted binding token
  proves completion if the final journal confirmation was interrupted.
- `observe(relativePath)`: read twice with content, file identity, metadata, and
  parent-directory checks; persist exact bytes and return a revisioned record.
  It does not change source files or make observations publishable engine saves.
- `write(relativePath, bytes, revision)`: require the recorded source identity and
  contents, durably retain the original and candidate, stage and flush the file,
  recheck the source and writer ownership, then atomically install. Existing
  POSIX mode/owner/group, ACLs, and extended attributes are retained through the
  platform's native copy into the private staging file. Creation never overwrites
  a competing file.
- `snapshot(relativePath)`: inspect durable observations and pending intents.
  An interrupted write blocks further observations/writes for that file until
  explicit recovery; it is never assumed complete or retried automatically.
- `inspect(relativePath)`: return the live file observation and durable record,
  including while a pending write blocks reconciliation; never adopt or clear it.
- `close()`: drain accepted work before releasing recovery ownership.

Source files are limited to 16 MiB. Traversal, symlinked source paths, nonregular
files, and hard-linked files are rejected. Missing sources remain observations,
not instructions to delete remote documents. Two matching reads cannot prove an
external writer has finished, and rename is not a filesystem compare-and-swap:
an uncooperative writer can still race the final check and installation. These
guards assume trusted source directories, not hostile directory replacement.
Directory watching and rescans are coordinated by the project session. Explicit
write/lock recovery and file lifecycle decisions use the native review views. Metadata
preservation uses `/bin/cp -p` on macOS and GNU `/bin/cp` with explicit
mode/ownership/xattr preservation on Linux. Copy failures hold installation;
intervening source metadata changes reject the staged replacement. Other
platforms require a metadata adapter before replacing existing source files.

Normal project connection and document opening use the workspace coordinator.
The session retains project metadata and detects remote renames, deletions, and
replacement IDs before applying source updates. Local saves remain possible
while those lifecycle changes are held. Compatibility sync commands use the same
reconciliation engine.

For a remote text-file rename or move, open the held source and use
`:Overleaf resolve` (also available through `:Overleaf conflicts`). Review the
old and new paths and press `a` to accept. The saved source is copied to the new
path; the same open buffer keeps its unsaved text and native undo tree. Future
writes use the new path. The old source and persistent undo file are retained.
An occupied destination file or buffer is never replaced; retain it elsewhere
before retrying. If a destination cannot be reviewed, the lifecycle view explains
the refusal and still offers keeping the original source local only. Changes to the source, document, or remote path invalidate the
review. A lost reply is checked against the committed binding before adopting
the new buffer name.

For a deleted text source, `:Overleaf resolve` offers `l` to keep it locally and
stop synchronization. Its saved bytes, dirty buffer, and native undo remain
unchanged; subsequent ordinary saves are local only, including after restart.
Previous remote targets and outgoing intents remain in recovery storage. An
already submitted update may still reach Overleaf. A replacement remote file
keeps its separate ID and cannot take ownership of this retained local path.
Press `a` in the lifecycle review to retain a separate local copy named
`<stem>.local-<identity hash><extension>`. This also moves the open buffer and its
undo tree, and frees the original path for the replacement. The original saved
file remains there as an independent local branch: differing replacement
contents require normal conflict resolution. An interrupted archive remains
reviewable; accepting `l` abandons the path change while retaining both copies.

Binary lifecycle reviews in `:Overleaf conflicts` offer `r` to accept a remote
rename, `l` to keep the file locally, and `a` to retain it at a separate local
path. These choices preserve exact bytes and never text-merge binaries. Cached
files remain available for review when absent from the remote tree.


</details>

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
