# Clause for OMP

Shows what [OMP](https://github.com/can1357/oh-my-pi) edits in [Clause](../README.md)'s Keep/Discard
review in VS Code and Cursor, next to what Claude Code edits.

It tracks OMP's `edit` and `write` tools, every shape those tools take (replace, patch, apply-patch,
hashline, sloppy). Before and after each call it runs `../claude-plugin/hook.mjs`, the same hook
Claude Code uses, so a file's baseline and the note about discards behave identically. A write OMP
hands to the VS Code editor is included: the tool waits until the editor has saved. The plugin
therefore works from a clone of this repository, not from this folder alone, and needs `node` on
the `PATH` that OMP runs with.

Install: [Quick start, step 6](../README.md#quick-start). Limits: [OMP](../README.md#limits).
