# opencode-plugin-memory

OpenCode plugin that gives the LLM PR-gated, project-scoped persistent memory. The LLM proposes durable knowledge; a human approves it by merging a pull request before it becomes shared truth.

## What This Is

An OpenCode plugin (`server` / `setup` hook) that:
- Registers five tools (`memory_propose`, `memory_update`, `memory_delete`, `memory_read`, `memory_review`) the LLM calls during every session
- Injects a compact index of active-memory titles into every system prompt (never full bodies)
- Runs an optional, model-judged semantic audit after sessions go idle (duplicate / refinement / contradiction detection via a restricted `memory-audit` subagent)

The LLM never writes shared truth directly. It only writes a proposal file into a machine-local, git-ignored `.memory/staging/` folder. A local **bot** (`src/bot.ts`) watches staging, branches, commits each proposal into `memory/active/`, and opens a pull request. A human merges it — merge is the only approval. The next session derives its prompt index from `memory/active/`.

## File Layout

```
src/
  index.ts        Plugin entry point — default export { id, server, setup }
  plugin.ts       server (V1) + setup (V2) hooks, config resolution, wiring
  tools.ts        Five memory tools (the LLM calls these; propose-only)
  storage.ts      Paths, frontmatter↔Memory mapping, read/write, id generation
  frontmatter.ts  Hand-rolled YAML frontmatter parse/serialize (zero-dependency)
  summary.ts      Prompt-index builder and the injected system-prompt block
  migrate.ts      Legacy MEMORY.md → per-file migration (idempotent)
  audit.ts        Model-judged semantic audit (prompt, parse, guards) + scheduler
  auditAgent.ts   Registers the restricted `memory-audit` subagent
  bot.ts          The bot: turns staged proposals into PRs (git/gh)
  prompt.ts       Shared memory-writing policy and behavior examples
  secret.ts       Credential-pattern scanning that blocks secret-bearing writes
  logging.ts      Append-only operation log
  types.ts        Memory, PluginConfig, RetiredReason, Intent types
```

Machine-local / workflow files:

```
.memory/staging/   agent's drop folder (git-ignored)
memory/active/     merged truth
memory/retired/    removed memories

There is no committed index file: the prompt index is derived from `memory/active/` at session start.
```

## Storage Format

State is positional — the folder a file lives in is its status (`active` / `retired` / `staging`). Each memory is one Markdown file with YAML frontmatter; the body follows the closing `---`.

Frontmatter fields (see `types.ts` `Memory`):

- `id` — random, collision-free (`mem-` + 8 base64url chars), never a counter
- `title` — one-line title shown in the index
- `tags`, `author`, `source` — grouping and provenance
- `proposed_at`, `approved_at`, `approved_by` — lifecycle timestamps/actors
- `supersedes` / `superseded_by` — forward and back links between replaced memories
- `retired_at`, `retired_reason` — retirement time + fixed-vocabulary reason (`wrong`, `stale`, `useless`, `superseded`, `duplicate`)
- `related_pr` — optional link to a motivating code change (provenance only)
- `intent` — staging-only directive for the bot: `propose` (default) or `retire`

Only `memory/active/` is ever injected into context; `retired/` and staging are never read by the runtime.

## The Five Tools

All tools are **propose-only**. They write to `.memory/staging/`; none edits `active/` or `retired/`.

### `memory_propose`
Writes `mem-<id>.md` to staging with `intent: propose`, after a duplicate check (against active + staging), a secret scan, and granularity/title-coherence validation. `supersedes: [old-id]` marks the proposal as a replacement for active memories.

### `memory_update`
Does not edit the active memory. Proposes a new memory carrying `supersedes: [id]`. Omitted fields are copied from the existing memory.

### `memory_delete`
Does not edit the active memory. Proposes a retirement: a staging file with `intent: retire` naming the target `id` and a `retired_reason`.

### `memory_read`
Returns full bodies of active memories (filterable by keyword) plus the author's own staged proposals (marked "pending — not yet merged"). Retired memories only when `include_retired` is true.

### `memory_review`
Read-only overview: active memories (id + title), pending proposals, aging entries, and retired (on request). Never edits anything.

## The Bot

`src/bot.ts` is the only component with repository credentials / git access. It is a local CLI, not a GitHub Action (an Action runs remotely and can never see a local git-ignored staging folder). It uses the `gh` CLI to open PRs.

Commands: `once` (process staging and exit), `watch` (poll staging). `regenerate` is accepted as a no-op for older CI jobs.

For each staged file it reads `intent`:
- `propose` → branch `memory/<id>`, commit the file into `memory/active/` (moving any `supersedes` targets to `memory/retired/` with `superseded_by` + `retired_reason: superseded`), push, open a PR, remove the staged file.
- `retire` → move `memory/active/<id>` to `memory/retired/` with the reason, open a PR, remove the staged file.

It is idempotent: a proposal whose branch already exists is skipped; a failed PR open leaves the staged file for the next poll.

## System Prompt Injection

The `experimental.chat.system.transform` (V1) / `context` (V2) hook runs before every request. It builds the index from `memory/active/` and injects:

- a memory-system introduction ("PR-gated project memory system");
- the index — one `[mem-XXXX] Title` line per active memory (titles and IDs only, never bodies), truncated to `maxSummaryChars` with a "showing a subset" notice when long;
- the complete writing policy (see `prompt.ts`), including granularity/title-coherence rules and few-shot examples.

Full bodies load only on demand via `memory_read`. Nothing is written: the index is recomputed every time, so it always matches merged truth.

## Configuration

In `opencode.json` / `opencode.jsonc`:

```jsonc
"plugin": [["@chncaesar/opencode-plugin-memory", { "maxSummaryChars": 3000 }]]
```

Options (all optional; see `types.ts` `PluginConfig` / `resolveConfig`):

- `maxSummaryChars` (number, default 2000): max characters for the injected index. The policy is injected separately.
- `enableLog` (boolean, default true): write an operation log to `.memory/plugin.log`.
- `staleDays` (number, default 90): active memories older than this are "aging" in `memory_review`. Informational only — nothing is retired on an age threshold.
- `backgroundAudit` (boolean, default true): run the model-judged semantic audit after sessions go idle.
- `auditIntervalMinutes` (number, default 1): minimum minutes between two background audits.

## Key Implementation Details

### Zod version

`@opencode-ai/plugin` 1.18.x bundles zod 4. Tools use `tool.schema` (the plugin's own zod instance), never `import { z } from "zod"`.

```typescript
const z = tool.schema  // ✅

import { z } from "zod" // ❌ different instance, type errors
```

### ID assignment

IDs are random and collision-free: `mem-` + `crypto.randomBytes(6).toString("base64url")`. There is no sequential counter — required because multiple branches may add memories concurrently. The sequential `MEM-NNN` scheme survives only inside the legacy migration path.

### Frontmatter is hand-rolled

`frontmatter.ts` is a zero-dependency parser/serializer for the strict `---`-delimited `key: value` + indented `- item` array format. Values that could misread (colons, `#`, leading `-`, quotes, newlines) are quoted/escaped so serialize→parse round-trips losslessly. `FIELD_ORDER` keeps a canonical key order.

### Migration

`migrate.ts` converts the legacy single-file `.opencode/memory/MEMORY.md` and `.agents/memory/MEMORY.md` (Active/Archived sections, `MEM-NNN` IDs, `nextSeq`) into one file per memory. A `memory/.migration.json` sidecar maps old IDs → new IDs so `superseded_by` links resolve. Idempotent; the legacy file is left in place.

### Secret scan

`memory_propose` and `memory_update` scan `title` + `content` before writing (see `secret.ts`). A match rejects the write with a "Memory not proposed" result naming the secret type — never the value.

### Audit

`audit.ts` runs after a session goes idle and, when the active set changed since the last audit and the interval has passed, asks a restricted `memory-audit` subagent (no tools, `small_model`) to compare every active memory for duplicate / refinement / contradiction. Each finding becomes an `intent: retire` staging proposal (with `superseded_by` for refinements), which the bot turns into a PR. The audit never edits `active/`. Guard state (`lastHash`, `lastAuditAt`) is machine-local in `.memory/audit-state.json` — the PR, not that file, is the durable record of a finding and its outcome.

### `exactOptionalPropertyTypes`

`tsconfig` enables `exactOptionalPropertyTypes: true`. Assign optional `Memory` fields conditionally, never spread `undefined`:

```typescript
if (m.tags) memory.tags = m.tags        // ✅
const x = { ...m, tags: undefined }     // ❌
```

### No concurrent write protection

File writes are not locked. This is acceptable for typical single-user usage; the review gate (PR) is the concurrency control. Do not add locking without tests.

## Development

```bash
npm run typecheck   # type-check only, no emit
npm run build       # compile to dist/
npm test            # compile + run unit tests (Node built-in runner)
```

Tests live next to modules as `*.test.ts`. `dist/` is committed for local plugin loading.

## What This Is Not

- Not a global memory store — scoped to the project directory OpenCode runs in
- Not direct-write — the LLM only proposes; merge (not the model) makes a memory valid
- Not a vector store / keyword scoring — duplicate detection is title/content matching at propose-time plus a model verdict in the background audit
- Not auto-expiring — nothing is retired on a timer; retirement always goes through a PR
