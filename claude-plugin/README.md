# Clause for Claude Code

Claude Code writes your files straight to disk. Clause keeps each of those changes **pending**
until you **Keep** or **Discard** it in VS Code or Cursor: one block, one file, or all at once.
Close Claude, close the editor, reboot: your review is where you left it.

This plugin is the Claude Code half. It saves what each file looked like before Claude's first
change to it. The review itself (green and red rows, the Keep and Discard bar, `Ctrl+Y` and
`Ctrl+N`) is drawn by the Clause extension for VS Code and Cursor, which you install separately.
Without that extension the plugin only records baselines and shows nothing.

## Install

```sh
claude plugin marketplace add Yashpal-0/clause
claude plugin install clause@clause --scope user
```

Then start a new Claude Code session, or run `/reload-plugins` in a running one. Node.js must be on
the `PATH` of the process that starts Claude Code, because the hooks run `node`. The extension and
its one-time setup are described in the
[project README](https://github.com/Yashpal-0/clause#quick-start).

## What it runs

Five hook events, each running `node` on `hook.mjs` from this plugin's own folder. There is no
MCP server, command, skill or agent, and nothing is installed or downloaded.

| Event | Runs on | What the hook does |
| - | - | - |
| `SessionStart` | every session | Removes leftovers of interrupted edits and remembers how much of the log of Discards the session has already seen. |
| `PreToolUse` | `Edit`, `Write`, `NotebookEdit` | Saves the file's bytes before the tool runs. |
| `PostToolUse` | `Edit`, `Write`, `NotebookEdit` | Keeps those bytes as the file's baseline if it was not pending yet, notes where the edit starts, and records the folder Claude was started in. |
| `PostToolUse` | `Bash` | Rebuilds baselines for files a shell command changed, only when Claude Code reports those changes (it does after you turn on `bashEditDiffEnabled` yourself). |
| `PostToolUseFailure` | `Edit`, `Write`, `NotebookEdit` | Drops the saved bytes of an edit that failed. |
| `UserPromptSubmit` | every prompt | If you discarded changes in the editor, adds a short note to your next prompt naming the files, so Claude re-reads them instead of building on code that is gone. |

The hooks always exit 0 and never block Claude's work. They do not change Claude Code's settings or
permissions.

## What it stores and what it sends

- **Stores**, only under `~/.claude/pending-edits/` (override with `CLAUDE_PENDING_EDITS_DIR`): a
  copy of each pending file as it was before Claude's first change, which includes files such as
  `.env` if Claude edits them; a small note per file with a time, a tool call id and a line number
  (no path, no content); the folders Claude sessions were started in (paths only); and, per
  session, a position in the log of Discards. Failures go to `errors.log` there, without file
  contents. Everything is readable only by you (modes 0600 and 0700).
- **Reads**: the files Claude edits, the hook payload Claude Code passes in, and the log of
  Discards that the extension writes (time, file path, and the kind of block with its line number,
  never content).
- **Sends**: nothing. No network calls, no telemetry, no accounts.
- **Clears**: when a file's last pending block is kept or discarded, its copy is deleted. Deleting
  the folder clears all pending state; every file keeps whatever it contains on disk.

## Uninstall

```sh
claude plugin uninstall clause@clause
claude plugin marketplace remove clause
```

Clause is an independent open-source project under the [MIT license](LICENSE), not affiliated with
or endorsed by Anthropic. Source, full documentation and issues:
[github.com/Yashpal-0/clause](https://github.com/Yashpal-0/clause).
