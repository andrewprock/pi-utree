# pi-utree

A [pi](https://pi.dev) extension that adds `/utree` — a conversation view with the same UX as the built-in `/tree`, filtered down to just the conversation:

```
  user: Fix the bug in foo.ts
  assistant: Found it — fixing now.
  user: Thanks, also check bar.ts
› • assistant: Done, bar.ts is fine.
```

## What it shows

- **User statements** and **assistant text responses** only
- Thinking blocks, tool calls, tool results, and session bookkeeping entries are excluded
- Chains of assistant messages within one turn (progress updates between tool calls) are collapsed to the **final** response, so the view alternates cleanly `user → assistant → user → assistant`

## What you can do with it

It reuses pi's own tree selector, so everything from `/tree` works:

- `↑/↓` move · `←/→` page
- Type to search
- Fold/unfold branch segments (`ctrl+←` / `ctrl+→`)
- `ctrl+x` copy the selected message
- Filter keys (`ctrl+u` for user-only, etc.) narrow further
- **Enter** navigates the session to the selected point, including `/tree`'s `Summarize branch?` prompt (Esc returns to the tree)
- **`ctrl+p`** previews the selected entry full screen, starting at its first line instead of the bottom of the transcript. Inside the preview:
  - `←/→` walk neighbouring entries
  - `j/k`, `↑/↓` line, `space/b`/`PgDn`/`PgUp` page, `g`/`G` top/bottom
  - `c` puts the entry in the editor as quoted context, ready for a follow-up question (nothing is sent until you press Enter)
  - `q`, `Esc` or `ctrl+c` closes the preview and returns to the tree on the entry you were reading

Returning to the tree after a preview rebuilds the picker, so a search query, filter or fold set beforehand is reset; the selection is kept.

In non-interactive mode (`pi -p`), `/utree` prints the collapsed transcript to stdout instead.

## Install

```bash
pi install npm:pi-utree
```

or from git:

```bash
pi install git:github.com/andrewprock/pi-utree
```

## Notes

- `shift+l` label editing is display-only here: extensions get a read-only session manager and cannot persist label changes (use `/tree` for that).
- The header says "Session Tree" — that string is shared with the built-in `/tree` component.

## License

MIT
