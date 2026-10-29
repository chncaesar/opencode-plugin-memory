# opencode-plugin-memory

OpenCode plugin that gives the LLM persistent, project-scoped memory across sessions.

## What This Is

An OpenCode plugin (`server` hook) that:
- Registers five tools (`memory_add`, `memory_update`, `memory_delete`, `memory_read`, `memory_review`) the LLM calls autonomously
- Injects a compact memory summary into every system prompt via `experimental.chat.system.transform`
- Runs an optional background consistency audit after sessions go idle

Memory is stored in plain Markdown files under the **project directory** (not global). Each project keeps its own memory.

Writes use a Claude Code–style hot-path: the LLM decides when to save/update/delete. The background audit is deliberately read-only with respect to memory — it only records findings, and the main session decides what to change.

## File Layout

```
src/
  index.ts        Plugin entry point — resolves config, wires hooks
  tools.ts        Five memory tools (the LLM calls these)
  storage.ts      MEMORY.md parser, serializer, CRUD, supersede chains
  review.ts       review.json state, placeholders, aging, dismissals, formatting
  audit.ts        Background audit: prompt, parse, guards, scheduler
  auditAgent.ts   Registers the restricted `memory-audit` agent
  prompt.ts       Shared memory-writing policy and behavior examples
  summary.ts      memory_summary.md builder and system-prompt block
  types.ts        MemoryEntry, MemoryStore, PluginConfig types
```

## Storage Format

All files live under `<projectDir>/.opencode/memory/`:

- `MEMORY.md` — main store, human-readable, LLM-writable
- `memory_summary.md` — compact index injected into system prompt (auto-generated, never edit manually)
- `review.json` — audit findings and dismissals, hash-scoped to the entries they describe (auto-managed)
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
- updated: 2026-09-07
- archived_at: 2026-09-07
- archived_reason: superseded
- superseded_by: MEM-007
Archived content.
```

Rules:
- Section headings (`## Active`, `## Archived`) must not be renamed — the parser keyed on them
- Entry IDs (`MEM-NNN`) are assigned sequentially by `nextSeq` — never reuse a deleted ID
- `memory_delete` is a soft delete: entries move to `## Archived`, never erased
- Metadata lines are parsed only in the leading block after an entry heading; once body text starts, `- key: value` lines stay body text
- `archived_at`, `archived_reason` and `superseded_by` apply to archived entries only

## The Five Tools

### `memory_add`
Creates a new entry. LLM should call when:
- User says "remember this" / "save this"
- A reusable coding rule or project convention is discovered
- A recurring bug pattern is fixed and the lesson should persist
- User corrects how the LLM communicates, reasons, edits, tests, or collaborates; unscoped corrections are durable by default
- User confirms a non-obvious approach worked well and should be repeated

Similarity between memories is never computed in code. The tool result only points at `memory_review` with `refresh: true` when the LLM wants an immediate model-judged check; otherwise the background audit handles it.

### `memory_update`
Updates title, content, or tags of an existing entry by ID. An ID-only call re-confirms the entry and bumps `updated`. Use `memory_read` first to confirm the ID if uncertain.

### `memory_delete`
Archives an entry by ID. Stores `reason` (one line) and an optional `superseded_by` link on the archived entry. To replace a memory's content, prefer `memory_add` with `supersedes`.

### `memory_read`
Returns full content of active entries, optionally filtered by keyword. `include_archived` also lists archived entries with their archive date, reason and replacement.

### `memory_review`
Lists audit findings, placeholder-like entries and aging entries, with full text. `dismiss` records "keep as is" for item keys; a dismissal expires when an involved entry changes. `refresh` runs the model audit immediately, bypassing the interval but still skipping unchanged entries.

## System Prompt Injection

`experimental.chat.system.transform` hook runs before every LLM request. It reads the store (`MEMORY.md`) and appends a memory block to `output.system` **on every request, even when empty**.

- Every store state receives the same complete writing policy, including default-to-save user feedback rules, temporary/task-local exclusions, and few-shot examples.
- Empty store → injects the memory-system introduction, an empty-state message, and the complete policy.
- Non-empty store → injects the summary (active entries as one-liners `[MEM-001] title`), the same complete policy, and at most one maintenance hint.

Entries are ordered by the later of `updated` and `added`, so a corrected entry is not the first to be truncated. If total chars exceed `maxSummaryChars`, the oldest entries are dropped. Default is 2000 chars (~500 tokens).

The maintenance hint is one line, for example `Memory maintenance: 1 possible memory conflict. Run memory_review when convenient.` It appears only when `memory_review` would show something: audit findings whose entries are unchanged, or placeholder-like entries. Aging alone never produces a hint. The hint is computed on every request with no model call.

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
- `staleDays` (number, default 90): Age threshold for the informational "aging" list in `memory_review`.
- `backgroundAudit` (boolean, default true): Run the consistency audit after sessions go idle.
- `auditIntervalMinutes` (number, default 60): Minimum minutes between audits.

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

### Supersede is atomic

`addSupersedingEntry` validates every ID in `supersedes` as an active entry before changing anything, collapses duplicates, then adds the new entry and archives the old ones in one store transition. Any bad ID means nothing is written. Archive links use `superseded_by` only; the forward `supersedes` relation is derived by reverse lookup so the two sides cannot disagree.

### Review findings are hash-scoped

A finding or dismissal stores a hash of the entries it involves. Editing any involved entry invalidates it, so stale verdicts cannot outlive the text they described. `pruneState` runs after every audit write.

### Background audit

**Input.** Every active entry, in file order, up to 200 entries. Archived entries are excluded and do not count toward the cap. Each entry is sent in full — ID, title, tags and complete body, with no truncation.

**Trigger.** After a session goes idle. Requires: audit enabled, 2 to 200 active entries, an active-entry hash different from the last completed audit, and `auditIntervalMinutes` since the last attempt. `memory_review refresh:true` bypasses the interval but not the unchanged-hash check, and waits for an in-flight audit before starting.

**Model.** A throwaway session under the hidden `memory-audit` agent registered by the plugin's `config` hook (`mode: subagent`, `hidden: true`, `steps: 1`, `permission: { "*": "deny" }`, short prompt). Permission denial removes every tool schema (including MCP) and omits the MCP instructions and skills list; project and global AGENTS.md are still injected and cannot be suppressed per agent. The agent uses `small_model` when configured, otherwise the session default model. There is no plugin option for this.

**Validation.** A finding needs at least two IDs, all active, and a relation in `duplicate`, `refinement` or `contradiction`; duplicate pairs are collapsed; reasons are clipped to 240 characters. There is no cap on the number of findings.

**Write.** On success, findings replace the previous list, `lastHash` and `lastAuditAt` update, dismissals are preserved, then findings whose entries changed or were archived are pruned. A model failure, unparsable reply, or verdict discarded because memories changed writes only `lastAuditAt`. A skipped run writes nothing, except that dropping below two entries clears findings. `review.json` is written atomically (temp file plus rename).

**Reader.** `memory_review` shows every stored finding with every involved entry in full, plus placeholder-like and aging entries. `dismiss` rewrites the file with the same read-modify-write, preserving findings.

The audit session is registered so both the event hook and the system-prompt hook ignore it.

### No concurrent write protection

File writes are not locked. Concurrent sessions writing to the same `MEMORY.md` can interleave, and two OpenCode instances may both run an audit. `review.json` is written via temp file plus rename so readers never see a partial file. This is acceptable for typical single-user usage. Do not add locking without also adding tests.

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

Tests use Node's built-in `node:test` runner (no extra dependencies) and live next to the modules as `*.test.ts`. `npm test` compiles and runs them.

## What This Is Not

- Not a global memory store — memory is scoped to the project directory OpenCode is running in
- Not a memory-writing background pipeline — the audit only records findings, and there is no session-end consolidation of memory
- Not a vector store and not keyword scoring — the only similarity judgment is a model's verdict in the background audit
- Not auto-expiring — aging is informational; nothing is archived on a timer
- Not Codex-style — no Phase 1/Phase 2, no SQLite evidence, no usage counters
