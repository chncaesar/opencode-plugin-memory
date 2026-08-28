# opencode-plugin-memory

Project-scoped persistent memory for [OpenCode](https://opencode.ai). The LLM autonomously saves, updates, and deletes knowledge across sessions — no background pipeline, no cloud dependency.

## How it works

- Four tools (`memory_add`, `memory_update`, `memory_delete`, `memory_read`) are registered with OpenCode and available to the LLM during every session
- A compact summary of all active memories is injected into every system prompt automatically
- Memory is stored as plain Markdown in `<projectDir>/.opencode/memory/MEMORY.md` — human-readable and inspectable at any time

Architecture: Claude Code–style hot-path. The LLM decides what to remember and when. There is no separate consolidation model or session-end pipeline.

## Installation

Install the published package:

```bash
npm i @chncaesar/opencode-plugin-memory
```

Then add it to your OpenCode configuration:

```jsonc
// opencode.json or ~/.config/opencode/opencode.jsonc

// Option 1 — from npm
"plugin": ["@chncaesar/opencode-plugin-memory"]

// Option 2 — from a local clone
"plugin": ["/path/to/opencode-plugin-memory"]

// Option 3 — with custom token budget
"plugin": [
  ["@chncaesar/opencode-plugin-memory", { "maxSummaryChars": 3000 }]
]
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `maxSummaryChars` | `number` | `2000` | Max characters injected into the system prompt. ~500 tokens at the default. |
| `enableLog` | `boolean` | `true` | Write an operation log to `.opencode/memory/plugin.log`. Set `false` to disable. |

```jsonc
// Disable logging
"plugin": [
  ["@chncaesar/opencode-plugin-memory", { "enableLog": false }]
]
```

## Storage

The plugin creates `.opencode/memory/` automatically on first write — no manual setup needed.

```
<projectDir>/
  .opencode/
    memory/
      MEMORY.md          # main store — LLM writes here, you can edit too
      memory_summary.md  # compact index — auto-generated, do not edit
      plugin.log         # operation log (add/update/delete + errors), if enableLog=true
```

Each entry looks like:

```markdown
### [MEM-001] 金额用 int 存储（cents）
- added: 2026-08-26
- tags: coding-style
永远用 int (cents) 存储金额，不用 double。输入用 CurrencyUtils.textToCents()。
```

Deleted entries are moved to an `## Archived` section rather than erased, so you can review or restore them by editing the file directly.

## When does the LLM save a memory?

The tool descriptions guide the LLM to call `memory_add` when:

- The user says "记住" / "remember this" / "save this"
- A reusable coding rule or project convention is discovered
- A recurring bug pattern is fixed and the lesson should persist
- The user corrects LLM behavior that should change permanently

It will not save temporary task-specific information or knowledge already in `AGENTS.md`.

## Development

```bash
npm install
npm run typecheck   # type-check only, no emit
npm run build       # compile to dist/
node --test         # run unit tests (Node built-in runner)
```

## Design notes

- **No global memory** — scoped to the project directory OpenCode runs in
- **No vector search** — retrieval is keyword-based or full-list; the summary handles ambient recall
- **No concurrent write protection** — designed for single-user usage; do not add locking without tests
- **Zod version** — uses `tool.schema` from `@opencode-ai/plugin` (zod 4), never `import { z } from "zod"` directly
