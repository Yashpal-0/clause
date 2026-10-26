# Clause for OpenCode

Shows what an OpenCode 2.x agent edits in [Clause](../README.md)'s Keep/Discard review in VS Code
and Cursor, next to what Claude Code edits.

It tracks OpenCode's `edit`, `write` and `patch` tools. Before and after each call it runs
`../claude-plugin/hook.mjs`, the same hook Claude Code uses, so a file's baseline and the note
about discards behave identically for both agents. It therefore works from a clone of this
repository, not from this folder alone, and needs `node` on the `PATH` that OpenCode runs with.

Install: [Quick start, step 5](../README.md#quick-start). Limits: [OpenCode](../README.md#limits).
