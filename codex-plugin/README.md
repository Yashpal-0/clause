# Clause for Codex

Shows what [Codex](https://developers.openai.com/codex/) changes through `apply_patch` in
[Clause](../README.md)'s Keep/Discard review in VS Code and Cursor. Added, edited, deleted and
moved files use the same pending-edits store as Claude Code, OpenCode and OMP.

Before a patch, the adapter saves the exact bytes of every file it may change. After the patch,
it calls `../claude-plugin/hook.mjs` for those files, so baseline rules and no-op handling stay in
one place. The next user prompt receives the same note about changes discarded in the editor.
Pending edits and discard cursors survive session restarts.

The manifest is `../.codex-plugin/plugin.json`. Codex CLI 0.166.0 loads command hooks from that
format; its newer root `plugin.json` format does not load host hooks.

Install: [Quick start, step 7](../README.md#quick-start). Codex CLI 0.166.0 was tested; use that
version or newer. Restart Codex after installing, then open `/hooks` and review and trust the
Clause commands before using them. Codex's [hook trust review](https://learn.chatgpt.com/docs/hooks)
is required.

The plugin needs this repository, including `claude-plugin/`, and `node` on the `PATH` Codex runs
with. It reads edited files and stores their original bytes locally under
`~/.claude/pending-edits/`; `CLAUDE_PENDING_EDITS_DIR` can override that with an absolute path.
That includes private files if Codex edits them. The store's directories and files use modes
0700 and 0600. Errors go to `errors.log` without file contents. The adapter makes no network calls.

Only native `apply_patch` calls that run the configured hooks are tracked. Arbitrary shell
commands, MCP tools and hosted or remote execution are not tracked. Local command hooks are
unavailable in cloud-orchestrated Work sessions. Limits: [Codex](../README.md#limits).
