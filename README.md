# Clause

Review everything Claude Code changed, after the fact, the way Cursor does. Claude's edits land on
disk right away. Every change stays **pending** until you click **Keep** or **Discard**, per block,
per file or all at once, no matter how many prompts, Claude sessions or editor restarts come in
between.

Claude Code decides at edit time: you approve an edit in the terminal and it leaves your view.
`/rewind` restores whole turns and `/diff` only shows changes. This project adds the missing step: a
review that stays open until you close it.

It has two parts, and you need both:

- **`claude-plugin/`** is a Claude Code plugin. Its hooks save what each file looked like before
  Claude's first change to it.
- **`vscode-extension/`** is a VS Code and Cursor extension. It shows the difference between that
  saved copy and the file as Keep/Discard blocks.

## What it looks like

In every editor that shows a file with pending changes:

- Added or changed lines have a full-width green background.
- Removed lines appear as real rows in the text, in full-width red, where they were removed.
- A bar sits at the right end of the row below each block, under its last green line (under the red
  rows of a block that only removed lines). It reads `^ 1 of 2 v | Discard Ctrl+N | Keep Ctrl+Y`. The
  counter counts this file's pending blocks, the arrows jump between them, **Discard** discards the
  block and **Keep** keeps it.
- The overview ruler has green and red marks. The editor title bar has Keep file, Discard file, Open
  diff and next/previous block.
- The **Clause** view in the Source Control sidebar lists files, then blocks, each
  with Keep and Discard buttons, and Keep All / Discard All at the top.
- The status bar shows `Claude: 3 pending · 2 files` and opens that view.
- When Claude edits a file, the editor opens it at the changed block on its own, as a preview tab
  and without taking keyboard focus. This is **Follow**; see Settings.
- In the file tree and on editor tabs, a file with pending changes has a violet `◆` after its name
  and a violet name. The folders above it are violet too, with a dot when collapsed. Git's letters
  and colours stay where they are: see Finding pending files.

## How it works

```
Claude Code ──hooks──▶  ~/.claude/pending-edits/  ◀──watches──  VS Code / Cursor extension
 (plugin)               entries/<id>/{base,meta.json,touched}    blocks = diff(base, file)
```

- Before Claude changes a file for the first time, the plugin stores the file's exact bytes (the
  *baseline*), or notes that the file did not exist. After every successful edit it also writes a
  small `touched` note: when, which tool call, and the line where the edit starts. That note is how
  the extension knows which file to open and where. It holds no path and no file content.
- The extension computes the pending blocks as the difference between the baseline and the file as
  you see it: the editor's text when the file is open (unsaved edits count), otherwise the file on
  disk. **Keep** moves the baseline forward to include the block. **Discard** reverts the file for
  that block.
- While a file has a pending block, every difference from its baseline is a block, whoever made it:
  Claude, you or a formatter. Nothing you type enters the baseline unless you Keep it. When the last
  block is kept or discarded, the file stops being tracked until Claude edits it again.
- The source of truth is that folder, not any process's memory. Close Claude, close the editor,
  crash it, reboot: the same blocks are there when you reopen. A block goes away only when you Keep
  or Discard it, or when the file really no longer differs there (for example, Claude undid its own
  change).
- Edits are recorded only after the tool call succeeded, so a denied or failed edit creates nothing.
- The next time you send Claude a prompt, it is told which files lost changes to a Discard, so it
  does not build on code that is gone. The note does not claim the changes were Claude's, because a
  block may be yours: it asks Claude to re-read the file before editing it again and not to
  re-apply discarded changes unless you ask.

## Requirements

- Claude Code (developed against 2.1.305). Tested with the CLI.
- Node.js on the `PATH` of the process that starts Claude Code: the hooks run `node`. Tested on
  Node 24; the plugin uses only Node's built-in modules.
- VS Code 1.100 or newer, or Cursor. Tested on Linux with VS Code 1.142. In Cursor 3.25.9 the
  extension activates and creates its views once `argv.json` allows the proposal (step 2 below),
  but how they look on screen has not been checked: Cursor's login screen blocked a clean test
  profile.
- `git`, only for the optional shell-command tracking below.

## Install

Replace `/path/to/clause` with where this repository is.

**1. Build and install the extension**

```sh
cd /path/to/clause/vscode-extension
npm install
npm run build
npx vsce package --no-dependencies --allow-missing-repository --skip-license
code --install-extension claude-pending-edits-0.1.0.vsix      # VS Code
cursor --install-extension claude-pending-edits-0.1.0.vsix    # Cursor
```

**2. Allow the proposed API (once per editor)**

The red rows and the bar are drawn with VS Code's `editorInsets` API, which is still a proposal.
Editors only let an extension use a proposal when it is named in their `argv.json`. Add this entry
to `~/.vscode/argv.json` for VS Code and to `~/.cursor/argv.json` for Cursor (in VS Code the
command palette entry is *Preferences: Configure Runtime Arguments*):

```jsonc
"enable-proposed-api": ["local.claude-pending-edits"]
```

Then quit the editor completely and start it again; `argv.json` is read at startup. Without this
step the extension still works, with a plainer view: green rows, a red marker with a hover for
removed lines, and the Discard/Keep bar as a CodeLens above each block.

**3. Install the plugin**

```sh
claude plugin marketplace add /path/to/clause
claude plugin install pending-edits@claude-pending-edits --scope user
```

Start a new Claude Code session, or run `/reload-plugins` in a running one. Claude Code installs a
copy of `claude-plugin/` (under `~/.claude/plugins/cache/`), so after you change the plugin's code,
uninstall it and install it again. Do that when you update from a version that had no Follow: its
plugin copy does not write the `touched` note and still words the discard note as if every
discarded change were Claude's. With that old copy the extension still shows every block and opens
the first edit to a file, but repeat edits to a file that is already pending are not followed.

**4. Optional: track shell commands**

Edits made by commands such as `sed -i` or a code generator are tracked only when Claude Code
reports them to hooks, which it does after this setting is on in `~/.claude/settings.json`:

```json
"bashEditDiffEnabled": true
```

It also needs the changed file to be inside a git repository. See the limits below.

## Using it

Put Claude Code in **accept edits** mode (Shift+Tab) to get the Cursor flow: it edits, you review
later. In the default mode you still approve each edit as before, and approved edits stay pending
too.

| Command (palette: "Claude Pending: …") | Default key |
|---|---|
| Keep Block / Discard Block | `Ctrl+Y` / `Ctrl+N`, while the cursor is inside a block |
| Keep File / Discard File | `Ctrl+Alt+C` then `Shift+K` / `Shift+D` |
| Go to Next / Previous Block | `Ctrl+Alt+C` then `N` / `P` |
| Keep All / Discard All | view toolbar, or the command palette |
| Open Diff | editor title bar: "before Claude" against "now" |

`Ctrl+Y` and `Ctrl+N` are active only while the cursor is inside a block, and there they take over
Redo and New File. All keys can be rebound in Keyboard Shortcuts (the command ids are
`claudePending.keepBlock`, `claudePending.discardBlock` and so on).

Rules worth knowing:

- If Claude edits code that is already in a block, the new edit merges into that block: the block
  always shows the original against the latest.
- Your own edits to a file that has pending blocks are blocks too, with the same Keep and Discard:
  typing next to a block grows it, typing anywhere else makes a new one, and Discard reverts it like
  any other block. A block does not know who wrote it, so Discard on a block that mixes Claude's
  lines with yours reverts both. A file with no pending block is not tracked, so editing it shows
  nothing.
- Discard goes through the editor, so `Ctrl+Z` brings the block back. **Keep cannot be undone**: it
  moves the baseline in the store. After a Discard the file is saved, unless it already had unsaved
  edits of yours.
- A file Claude created is one block. Discarding it moves the file to the trash; it never deletes it
  outright, and on a system without a trash it refuses.
- A pending file that is deleted later shows as deleted. Discard recreates it from the baseline.
- Notebooks, binary and non-UTF-8 files, and files over 2 MB get file-level Keep, Discard and Open
  diff only.
- Keep All and Discard All act on this window's workspace folders only, because the store is shared
  by the whole machine. Pending files elsewhere appear under "Other locations", with their own
  buttons. Discard All asks for confirmation.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `claudePending.followEdits` | on | Open the file Claude has just edited, at the changed block |

The colour of the file tree marker is the workbench colour `claudePending.explorerForeground`
(default `charts.purple`). Change it in `workbench.colorCustomizations`.

**Follow.** About 0.4 s after the last edit lands, the editor opens the file as a preview tab,
puts the cursor at the start of the changed block, so that `Ctrl+Y` and `Ctrl+N` act on it, and
scrolls the block into view. If the block is already in view, nothing moves. Keyboard focus stays
where it was, in your terminal or in the editor you were using. In the test VM the file was on
screen 0.6 to 0.8 s after Claude's edit tool call finished.

- It waits until you have not typed in any editor for 3 seconds, then runs; it is not dropped.
- It follows files inside this window's workspace folders only. A window with no folder open
  follows nothing, and another project's edits never move this window.
- Edits less than 0.4 s apart open once, on the newest, so a burst of edits to many files ends on
  the last file instead of flickering through all of them.
- Notebooks, binary files and files over 2 MB are never opened this way.
- Starting the editor with changes already pending opens nothing. Only new edits do.

## Finding pending files

Every file with at least one pending block has, in the file tree and on its editor tab:

- a violet `◆` after its name, with the tooltip "3 changes waiting for Keep or Discard";
- its name in violet.

Every folder above it, up to the workspace folder, has a violet name, and a violet dot when it is
collapsed, so you can tell where to look without opening it. Git's letters stay: a modified file
with pending changes reads `◆, M`. A file with nothing pending keeps git's own colour, green when
untracked and yellow when modified. A repository with no commits is green all over, which is why
a colour alone cannot tell the files apart and the shape does.

Why it works this way. VS Code merges what every decoration provider says about a file into one
label colour and one badge text. Git uses letters and its own colours, so the marker is a glyph
that is neither a letter nor a digit, in a colour git does not use. The label colour is taken from
the newest provider that has one, and git registers its providers after the extension's: one for
each repository it opens, and all of them again when `git.decorations.enabled` is switched on. So
the extension registers its own again after git does, and tells the file tree to ask about every
marked file again, because a new registration starts with nothing cached. Folders get a colour of
their own for the same reason: a folder without one takes the colour of whichever provider
answered about a child first, which can be git.

`explorer.decorations.badges` and `explorer.decorations.colors` switch the marks off, git's
included. The extension has no setting for it. The Source Control view and the status bar remain
the list of what is pending, and its count.

## Limits

**View**

- The bar is a row of its own below the block, so the bar of a long block is at its end, off screen
  until you scroll there. `Ctrl+Y` and `Ctrl+N` inside the block, the title-bar buttons and the
  Clause view work from anywhere.
- An inset is as wide as the editor, so the editor's scrollbar is drawn over its right end. The bar
  stops 18px short of that end: the default 14px scrollbar plus the 4px gap Cursor leaves. With the
  default minimap on, it also stops short of the minimap. A larger
  `editor.scrollbar.verticalScrollbarSize` puts the end of Keep under the scrollbar.
- Removed lines are plain text without syntax colors, and they do not scroll sideways with the
  editor.
- Each inset is a webview, and a block that replaced lines has two: its removed lines above the new
  ones, and its bar below them. At most 16 blocks per editor use the new view, so at most 32
  webviews; further blocks use the CodeLens fallback. An inset shows at most 200 removed lines (Open
  diff shows all).
- It relies on a proposed API: the extension cannot be published to the Marketplace, and an editor
  update can change the proposal. If that happens the extension falls back to the plainer view and
  no data is affected.
- Code folding, word wrap and editor zoom have not been tried with the view on.

**File tree and Follow**

- VS Code gives the Problems decoration (errors and warnings) more weight than an extension's, so
  by its merge rules a file with errors is drawn in the Problems colour instead of violet. The `◆`
  stays. This comes from VS Code's source; it has not been checked on screen.
- A workspace opened through a symlink gets its file marks late or not at all, and no folder marks:
  the extension names files by their real path, and the file tree asks under the folder's own
  spelling. On Windows, a drive letter in another case does the same.
- A workspace folder added while the window is open gets folder marks from the next time a file's
  pending count changes.
- If the git extension is switched on after the window started, only a change of
  `git.decorations.enabled` (or reloading the window) makes the marker register again after git,
  until then its colour can lose to git's.
- Follow replaces your preview tab and moves the cursor in the file it opens. A Discard edits the
  document, so it counts as typing for the 3-second wait.
- A repeat shell-command edit (`bashEditDiffEnabled`) to a file that is already pending is not
  followed: shell edits write no `touched` note. A file first changed by a shell command is.
- Cursor's rendering of the marker has not been seen; VS Code's has, in dark and light themes.

**Tracking**

- Edits you make outside the editor (vim, `git checkout`), format on save and auto-fix, to a file
  with pending changes, show up inside its blocks.
- A window compares the editor's text, so another window with the same file open sees your typing
  only after you save it.
- When you discard the last block of a file in an open, otherwise clean editor, the file stops being
  pending. `Ctrl+Z` restores the text, but not the pending state.
- Each hook costs one Node start-up, about 50 ms, including one per Bash command. If `node` is not
  on the `PATH` of the process that started Claude Code, the hooks fail without blocking Claude and
  nothing is recorded.
- A keystroke inside a block of a 20,000-line file takes about 100 ms to process.

**Shell commands** (`bashEditDiffEnabled` on, file inside a git repository). Not tracked: commands
that exit non-zero; background commands; binary and non-UTF-8 files; commands that change more than
5 files; hunks of 400 lines or more; git-ignored files and files outside the repository; deleting a
file that had content; symlinks; `git checkout`, `switch`, `stash`, `reset` and similar; mode-only
changes; a changed last line when Claude Code's report cannot say whether the file ended with a
newline; a created file when the same command also changed a file that could not be rebuilt. Files
moved in from an ignored or outside location are recorded as created (Discard sends them to the
trash). Build output that is not git-ignored shows up as noise; Keep All clears it. Edits you make
in the editor while a Bash command runs may be attributed to Claude. The file-watcher path that
reports later commands exists on Linux only.

## Data and privacy

The store at `~/.claude/pending-edits/` (override with `CLAUDE_PENDING_EDITS_DIR`) holds a copy of
each file Claude changed, as it was before, until you Keep or Discard. That includes files such as
`.env` if Claude edits them. Next to each copy is a `touched` note with a time, a tool call id and a
line number, and no path or content. Everything stays on your machine, in files and directories
only you can read (modes 0600 and 0700). Hook failures are written to `errors.log` in the same
folder, without file contents.

Deleting the folder clears all pending state. Every file keeps whatever it contains on disk.

## Uninstall

```sh
claude plugin uninstall pending-edits@claude-pending-edits
claude plugin marketplace remove claude-pending-edits
code --uninstall-extension local.claude-pending-edits
cursor --uninstall-extension local.claude-pending-edits
```

Then remove the `enable-proposed-api` entry from `~/.vscode/argv.json` and `~/.cursor/argv.json`,
the `bashEditDiffEnabled` line from `~/.claude/settings.json` if you added it, and, if you want,
`~/.claude/pending-edits/`.

## Development

```
.claude-plugin/marketplace.json   local marketplace that points at claude-plugin/
claude-plugin/                    hooks, store and reverse-diff: plain JavaScript with JSDoc types
vscode-extension/                 the extension: TypeScript, bundled by esbuild
package.json, tsconfig.plugin.json  tooling for the plugin, kept outside claude-plugin/ because
                                  the marketplace copies that folder
```

```sh
npm install && npm test                 # plugin: typecheck, then node --test
cd vscode-extension
npm install && npm test                 # extension: typecheck, then unit tests
npm run test:integration                # runs the installed VS Code (/usr/share/code/code) under xvfb
```

The integration run starts four editor configurations: the editor as most users have it (no
proposal allowed), the editor with the proposal allowed, and a close-and-reopen pair. Each has its
own workspace, store and `HOME`, so the `argv.json` from step 2 of the install does not change what
a run allows. `.vscode-test.mjs` points at `/usr/share/code/code`; change that path if VS Code is
installed elsewhere. Tests must never touch the real `~/.claude/pending-edits`, which is
why `CLAUDE_PENDING_EDITS_DIR` exists.
