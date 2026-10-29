# opencode-plugin-memory

Project-scoped persistent memory for [OpenCode](https://opencode.ai). The LLM autonomously saves, updates, and deletes knowledge across sessions, and memories are kept consistent as they age. No cloud dependency, no vector database.

## How it works

- Five tools (`memory_add`, `memory_update`, `memory_delete`, `memory_read`, `memory_review`) are registered with OpenCode and available to the LLM during every session
- A compact summary of all active memories is injected into every system prompt automatically
- Memory is stored as plain Markdown in `<projectDir>/.opencode/memory/MEMORY.md` — human-readable and inspectable at any time
- Writes surface the most similar existing memories so the LLM can resolve duplicates and contradictions immediately
- An optional background audit runs after a session goes idle and records possible conflicts for review. It never edits memory itself.

Architecture: Claude Code–style hot-path for writes. The LLM decides what to remember and when. Consistency is checked by a model in a background audit that only writes findings to `review.json`; the main session decides what to change.

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
| `maxSummaryChars` | `number` | `2000` | Max characters used by the memory-entry summary. The fixed writing policy is added separately. |
| `enableLog` | `boolean` | `true` | Write an operation log to `.opencode/memory/plugin.log`. Set `false` to disable. |
| `staleDays` | `number` | `90` | Entries not touched for this long are listed as "aging" in `memory_review`. Informational only; nothing is archived. |
| `backgroundAudit` | `boolean` | `true` | Run the semantic consistency audit after sessions go idle. |
| `auditIntervalMinutes` | `number` | `60` | Minimum minutes between two audits. |

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
      review.json        # audit findings and dismissals — auto-managed, do not edit
      plugin.log         # operation log (add/update/delete/audit + errors), if enableLog=true
```

Each entry looks like:

```markdown
### [MEM-001] Store monetary amounts as integer cents
- added: 2026-08-26
- tags: coding-style
Always store monetary amounts as integer cents, not floating-point values. Parse input with CurrencyUtils.textToCents().
```

Deleted entries are moved to an `## Archived` section rather than erased, so you can review or restore them by editing the file directly. Archived entries record why and what replaced them:

```markdown
### [MEM-002] Old rule
- added: 2026-08-20
- updated: 2026-09-07
- archived_at: 2026-09-07
- archived_reason: superseded
- superseded_by: MEM-007
Old content.
```

## Memory evolution

Memories go stale or contradict each other. Three mechanisms keep the store consistent:

- **Model-judged comparison.** Similarity is never computed by keyword matching. A restricted background agent reads the entries and reports duplicate, refinement and contradiction pairs. You can force that check at any time with `memory_review` and `refresh: true`.
- **Supersede in one step.** `memory_add` with `supersedes: ["MEM-004"]` saves the new entry and archives the old one with `archived_reason: superseded` and a `superseded_by` link. If any ID is not an active memory, nothing is saved.
- **Background audit.** After a session goes idle, if the set of active memories changed and the interval has passed, a model is asked to report duplicate, refinement and contradiction pairs. Every active memory is sent in full, up to 200 entries, with no truncation and no cap on findings. Findings are cached in `review.json` and invalidated automatically when any involved entry changes. A one-line hint in the system prompt points the LLM at `memory_review`.

`memory_review` shows the findings with the full text of the entries involved, placeholder-like entries (test/temporary leftovers) and aging entries. With `refresh: true` it runs the model check immediately instead of showing cached results. The LLM then resolves the findings with `memory_update`, `memory_add` with `supersedes`, or `memory_delete` with a reason. Items that should stay as they are can be dismissed; a dismissal lasts until one of the entries changes.

The audit runs in a restricted, hidden `memory-audit` agent created by the plugin: no tools, no MCP schemas, no skills list, a one-step limit. It uses your `small_model` when configured, otherwise the session default model.

## When does the LLM save a memory?

The system prompt and tool description guide the LLM to call `memory_add` when:

- The user says "remember this" / "save this"
- A reusable coding rule or project convention is discovered
- A recurring bug pattern is fixed and the lesson should persist
- The user corrects how the LLM communicates, reasons, edits, tests, or collaborates
- The user confirms that a non-obvious approach worked well and should be repeated
- A memory needs correcting, replacing, or removing because it went stale or conflicts with new information

Unscoped corrections and preferences are treated as durable by default; the user does not need to say "remember this". Instructions explicitly limited to the current answer, task, file, or one-time situation are not saved. The same complete policy and few-shot examples are injected whether the memory store is empty or already contains entries.

## Development

```bash
npm install
npm run typecheck   # type-check only, no emit
npm run build       # compile to dist/
npm test            # compile + run unit tests (Node built-in runner)
```

## Design notes

- **No global memory** — scoped to the project directory OpenCode runs in
- **No vector search and no keyword scoring** — the audit asks a model to compare entries; only the model's verdict is used
- **The audit never writes memory** — it only produces findings; the main session decides
- **No concurrent write protection** — designed for single-user usage; do not add locking without tests
- **No verified-date field** — an entry is "fresh" when `updated` changes; `memory_update` with only an ID re-confirms it
- **Zod version** — uses `tool.schema` from `@opencode-ai/plugin` (zod 4), never `import { z } from "zod"` directly
