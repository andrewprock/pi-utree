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
