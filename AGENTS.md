# opencode-plugin-memory

OpenCode plugin that gives the LLM persistent, project-scoped memory across sessions.

## What This Is

An OpenCode plugin (`server` hook) that:
- Registers four tools (`memory_add`, `memory_update`, `memory_delete`, `memory_read`) the LLM calls autonomously
- Injects a compact memory summary into every system prompt via `experimental.chat.system.transform`

Memory is stored in plain Markdown files under the **project directory** (not global). Each project keeps its own memory.

Architecture is Claude Code–style hot-path: the LLM decides when to save/update/delete during a session. There is no background pipeline or second LLM.

## File Layout

```
src/
  index.ts      Plugin entry point — resolves config, wires hooks
  tools.ts      Four memory tools (the LLM calls these)
  storage.ts    MEMORY.md parser, serializer, and CRUD operations
  summary.ts    memory_summary.md builder (token-bounded injection)
  types.ts      MemoryEntry, MemoryStore, PluginConfig types
```

## Storage Format

All files live under `<projectDir>/.opencode/memory/`:

- `MEMORY.md` — main store, human-readable, LLM-writable
- `memory_summary.md` — compact index injected into system prompt (auto-generated, never edit manually)
- `plugin.log` — append-only operation log (created when `enableLog=true`, which is the default)

The `.opencode/memory/` directory is created automatically on first write — no manual setup needed.

### MEMORY.md structure

```markdown
# OpenCode Memory
<!-- nextSeq: 3 -->

## Active

### [MEM-001] Title
- added: 2026-08-26
- updated: 2026-08-27
- tags: coding-style, workflow
Full content body here.

## Archived

### [MEM-002] Old entry
- added: 2026-08-20
Archived content.
```

Rules:
- Section headings (`## Active`, `## Archived`) must not be renamed — the parser keyed on them
- Entry IDs (`MEM-NNN`) are assigned sequentially by `nextSeq` — never reuse a deleted ID
- `memory_delete` is a soft delete: entries move to `## Archived`, never erased

## The Four Tools

### `memory_add`
Creates a new entry. LLM should call when:
- User says "remember this" / "记住"
- A reusable coding rule or project convention is discovered
- A recurring bug pattern is fixed and the lesson should persist
- User corrects LLM behavior that should change permanently

### `memory_update`
Updates title, content, or tags of an existing entry by ID. Use `memory_read` first to confirm the ID if uncertain.

### `memory_delete`
Soft-deletes (archives) an entry by ID. Entry moves to `## Archived` section — not erased.

### `memory_read`
Returns full content of active entries, optionally filtered by keyword. Use before `memory_update`/`memory_delete` to find exact IDs.

## System Prompt Injection

`experimental.chat.system.transform` hook runs before every LLM request. It reads the store (`MEMORY.md`) and appends a memory block to `output.system` **on every request, even when empty**.

- Empty store → injects a cold-start block explaining the memory system exists and listing `memory_add` triggers. Without this, a fresh project gives the LLM zero signal that memory tools are available.
- Non-empty store → injects the summary (active entries as one-liners `[MEM-001] title`, newest-first) plus a "maintain this memory" nudge reminding the LLM to keep saving durable knowledge.

The summary lists active entries as one-liners (`[MEM-001] title`), newest-first. If total chars exceed `maxSummaryChars`, oldest entries are truncated. Default is 2000 chars (~500 tokens).

## Configuration

In `opencode.json` / `opencode.jsonc`:

```jsonc
// Simple (default config)
"plugin": ["/path/to/opencode-memory"]

// With options
"plugin": [
  ["/path/to/opencode-memory", { "maxSummaryChars": 3000 }]
]
```

Available options (all optional):

- `maxSummaryChars` (number, default 2000): Max characters injected into system prompt. Approx 1 token per 4 chars.
- `enableLog` (boolean, default true): Write operation log to `.opencode/memory/plugin.log`. Set false to disable.

## Key Implementation Details

### Zod version

`@opencode-ai/plugin` 1.18.x bundles zod 4. Tools use `tool.schema` (the plugin's own zod instance) instead of importing zod directly. Never `import { z } from "zod"` — it will cause type incompatibility at runtime.

```typescript
// ✅ Correct
const z = tool.schema

// ❌ Wrong — different zod instance, type errors at compile time
import { z } from "zod"
```

### ID assignment

IDs are sequential (`MEM-001`, `MEM-002`, …). The `nextSeq` counter is embedded in a HTML comment in `MEMORY.md` and incremented on every `memory_add`. Archived entries keep their original ID; the counter never resets.

### No concurrent write protection

File writes are not locked. Concurrent sessions writing to the same `MEMORY.md` can interleave. This is acceptable for typical single-user usage. Do not add locking without also adding tests.

### `exactOptionalPropertyTypes`

The tsconfig enables `exactOptionalPropertyTypes: true`. When constructing `MemoryEntry` objects, optional fields (`updated`, `tags`) must be assigned conditionally, not spread with `undefined`:

```typescript
// ✅ Correct
if (e.updated) entry.updated = e.updated

// ❌ Wrong — fails exactOptionalPropertyTypes
const entry = { ...e, updated: e.updated }
```

## Development

```bash
# Type-check only (no emit)
npm run typecheck

# Build to dist/
npm run build
```

No test framework is set up yet. When adding tests, use Node's built-in `node:test` runner (no extra dependencies).

## What This Is Not

- Not a global memory store — memory is scoped to the project directory OpenCode is running in
- Not a background pipeline — there is no session-end consolidation, no second LLM
- Not a vector store — retrieval is keyword-based (`searchEntries`) or full-list
- Not Codex-style — no Phase 1/Phase 2, no SQLite evidence, no usage counters
