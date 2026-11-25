# opencode-plugin-memory

OpenCode plugin that gives the LLM PR-gated persistent memory in two stores: a global one (a private repository cloned on the machine, read by every session) and a project one (a repository's own `memory/` folder). The LLM proposes durable knowledge; a human approves it by merging a pull request before it becomes shared truth.

## What This Is

An OpenCode plugin (`server` / `setup` hook) that:
- Registers six tools (`memory_propose`, `memory_update`, `memory_delete`, `memory_read`, `memory_review`, `memory_publish`) the LLM calls during every session
- Injects a compact index of active-memory titles from both stores into every system prompt (never full bodies)
- Runs an optional, model-judged semantic audit after sessions go idle (duplicate / refinement / contradiction detection via a restricted `memory-audit` subagent)

The LLM never writes shared truth directly. It only writes a proposal file into a machine-local, git-ignored `.memory/staging/` folder. A local **bot** (`src/bot.ts`) watches staging, branches, commits each proposal into `memory/active/`, and opens a pull request. A human merges it — merge is the only approval. The next session derives its prompt index from `memory/active/`.

## Two stores

- **Global** — one private repository of the user, cloned at `globalMemoryPath` (default `~/.local/share/opencode/memory`), read by every session in every repository. Proposals default here.
- **Project** — the current repository's own `memory/` folder in Git, shared with whoever has the repository. At runtime a Git project uses one persistent plugin-managed sparse worktree under `~/.local/share/opencode/project-memory/<name>-<hash>/worktree` that tracks the remote default branch, so refreshes never touch the developer's active checkout. Used only for knowledge that is true because of that repository.

Both stores use the same layout and the same code; a store is just a root directory. Each has its own staging folder, bot lock, audit state and pull-request flow, so one store failing never blocks the other. A missing or unreadable global store degrades to project-only memory — it must never break a session. An unusable managed project store fails project memory closed instead of silently falling back to the developer's working copy. A supersede stays inside one store, because the replacement must retire its target in the same PR.

The two prompt indexes share `maxSummaryChars`; the project store keeps at least `1 - globalIndexShare` of it reserved so a large global store cannot hide project entries, and unused budget goes to the other side. See `src/stores.ts`.

## File Layout

```
src/
  index.ts        Plugin entry point — default export { id, server, setup }
  plugin.ts       server (V1) + setup (V2) hooks, config resolution, wiring
  tools.ts        Six memory tools (the LLM calls these; propose-only)
  storage.ts      Paths, frontmatter↔Memory mapping, read/write, id generation
  stores.ts       Global/project store resolution, scope defaults, degradation
  projectStore.ts Persistent plugin-managed project worktree, refresh transaction, access lease
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
- `retired_at`, `retired_reason` — retirement time + fixed-vocabulary reason (`wrong`, `stale`, `useless`, `superseded`, `duplicate`, `implemented`); `implemented` records that the rule graduated into code/tests/docs and the memory would only duplicate it
- `related_pr` — optional link to a motivating code change (provenance only)
- `intent` — staging-only directive for the bot: `propose` (default) or `retire`

Only `memory/active/` in each store is ever injected into context; `retired/` and staging are never read by the runtime.

## The Tools

All tools are **propose-only**. They write to the chosen store's `.memory/staging/`; none edits `active/` or `retired/`.

### `memory_propose`
Writes `mem-<id>.md` to the target store's staging (`scope`: `global` by default, else `project`) with `intent: propose`, after a duplicate check against both stores, a secret scan, and granularity/title-coherence validation. `supersedes: [old-id]` marks the proposal as a replacement for active memories **in the same store**; cross-store ids are rejected so the bot can retire the target in the same PR.

### `memory_update`
Does not edit the active memory. Finds the entry in whichever store holds it, then proposes a new memory carrying `supersedes: [id]` into that same store. Omitted fields are copied from the existing memory.

### `memory_delete`
Does not edit the active memory. Proposes a retirement: a staging file with `intent: retire` naming the target `id` and a `retired_reason`, in the store that holds the target.

### `memory_read`
Returns full bodies of active memories from both stores (filterable by keyword) plus the author's own staged proposals (marked "pending — not yet merged"). Retired memories only when `include_retired` is true. Output is grouped by store, so the origin of every entry is explicit.

### `memory_review`
Read-only overview per store: active memories (id + title), pending proposals, aging entries, audit status, and retired (on request). Never edits anything.

### `memory_publish`
Runs the bot once per store with pending proposals and returns the PR URLs grouped by store. A store whose publish fails stays staged and never blocks the other.

## The Bot

`src/bot.ts` is the only component with repository credentials / git access. It is a local CLI, not a GitHub Action (an Action runs remotely and can never see a local git-ignored staging folder). It uses the `gh` CLI to open PRs.

Commands: `once` (process staging and exit), `watch` (poll staging). `regenerate` is accepted as a no-op for older CI jobs.

For each staged file it reads `intent`:
- `propose` → branch `memory/<id>`, commit the file into `memory/active/` (moving any `supersedes` targets to `memory/retired/` with `superseded_by` + `retired_reason: superseded`), push, open a PR, remove the staged file.
- `retire` → branch `memory/retire/<id>-<timestamp>` (the add branch for that id is normally still present), move `memory/active/<id>` to `memory/retired/` with the reason, push, open a PR, remove the staged file.

It is idempotent by recovery, not by skipping: a branch already on the remote means an earlier run pushed but stopped before the PR, so the bot finds that PR (or opens it) and clears the staged file. A failed git/`gh` step leaves the staged file for the next poll. A `retire` whose target is already gone is reported as `skipped` with the staged file left in place — retried on every later run until deleted by hand; a `propose` that would change no file fails instead, because git refuses an empty commit.

## System Prompt Injection

The `experimental.chat.system.transform` (V1) / `context` (V2) hook runs before every request. It builds one index per available store and injects:

- an introduction naming both stores and the default ("global unless this repository is what makes it true");
- the global index, then the project index — one `[mem-XXXX] Title` line per active memory (titles and IDs only, never bodies) — sharing `maxSummaryChars`, with the project section's `1 - globalIndexShare` reserved and per-section truncation notices;
- a one-line, path-free notice when the global store is unusable (the path appears only in tool output);
- the complete writing policy (see `prompt.ts`), including the store-choice rule, granularity/title-coherence rules and few-shot examples.

Full bodies load only on demand via `memory_read`. Nothing is written: the index is recomputed every time, so it always matches merged truth.

## Configuration

See the [user guide](docs/index.md#before-you-begin) for supported host versions. In `opencode.json` / `opencode.jsonc`, use `plugins` (plural) with an object entry for options:

```jsonc
"plugins": [{ "package": "@chncaesar/opencode-plugin-memory", "options": { "maxSummaryChars": 3000 } }]
```

The supported loader uses `setup`. The legacy `server` entry is not a support guarantee.

Options (all optional; see `types.ts` `PluginConfig` / `resolveConfig`):

- `maxSummaryChars` (number, default 10000): shared character budget for both injected indexes. The policy is injected separately.
- `globalMemoryEnabled` (boolean, default true): enable the global store. `false` reproduces the old project-only behaviour.
- `globalMemoryPath` (string, default `~/.local/share/opencode/memory`): where the global store is cloned. Missing → project-only, with a notice; never an error.
- `defaultScope` (`global` | `project`, default `global`): scope for a proposal that does not name one. Falls back to `project` when the global store is unusable, so an omitted scope never fails.
- `globalIndexShare` (number in (0,1), default 0.7): maximum share of the budget the global index may use; the project index keeps at least the rest reserved.
- `enableLog` (boolean, default true): write an operation log to `.memory/plugin.log`.
- `staleDays` (number, default 90): active memories older than this are "aging" in `memory_review`. Informational only — nothing is retired on an age threshold.
- `backgroundAudit` (boolean, default true): run the model-judged semantic audit after sessions go idle.
- `auditIntervalMinutes` (number, default 1): minimum minutes between two background audits.
- `auditProvider` (object, default none): make the audit call a provider directly instead of asking the host to generate the text — `{ baseUrl, apiKey, model }`, OpenAI-compatible `/chat/completions`. `apiKey` may be a literal, `{file:path}`, or `{env:NAME}`. OpenCode expands those references **before** the plugin sees the options, so a missing key file arrives as an empty string and the audit fails with `"auditProvider" is missing apiKey` (the plugin's own resolver only runs when a host passes the reference through verbatim). Use it when the host's account credential (a PAT or OAuth login) is rejected by an inference gateway. A partial `auditProvider` is not ignored: the audit fails with the missing-field message instead of silently falling back to the host's credential.

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

`audit.ts` runs after a session goes idle and, when the active set changed since the last audit and the interval has passed, asks a model to compare every active memory for duplicate / refinement / contradiction. Each finding becomes an `intent: retire` staging proposal (with `superseded_by` for refinements), which the bot turns into a PR. The audit never edits `active/`. Guard state (`lastHash`, `lastAuditAt`) is machine-local in `.memory/audit-state.json` — the PR, not that file, is the durable record of a finding and its outcome.

The audit has **no credential of its own by default**: it asks the host to generate text, so it inherits the model and credential the host resolved. OpenCode 2.x relays model calls through its own inference gateway (`opencode.ai/inference/...`), which rejects an account token (PAT or OAuth login) with `HTTP 400 … Personal Access Tokens are not supported for this endpoint` — a credential-type rejection, not a quota error. Configuring `auditProvider` makes the plugin POST to the provider itself (OpenAI-compatible `/chat/completions`) with a key it reads from a literal, `{file:...}` or `{env:...}`, which is the only way to guarantee the audit never depends on the host's account state.

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

## User Guide and Releases

- The English user guide is maintained in [`docs/index.md`](docs/index.md) and published at https://chncaesar.github.io/opencode-plugin-memory/.
- After each release, review and update the user guide to reflect the released version, including affected features, configuration options, defaults, and examples. Publish the updated guide with the release documentation.

### Release notes are written for readers

Release notes are the input to promotion: automated fact extraction reads them and
quotes them. A note listing test names produces facts about test names. One
measured run extracted 39 claims from the v0.6.0 note; 38 described internal
implementation and only one could be used in an article.

Use these three sections, in this order:

```markdown
## What you can do now      <!-- one user-visible capability per line, verb-first -->
## Upgrading               <!-- required steps, or "no action needed" -->
## Known limitations       <!-- what does not work, stated without hedging -->
```

Do not write test names, internal file paths, module or function names, or
"updated tests" / "refactored X" — unless the change is something a user
perceives. Describe what a reader can now do, not how it was implemented.

## What This Is Not

- Not project-only, and not one store: a global private store is read in every repository, a project store travels with its repository, and each publishes to its own pull request
- Not direct-write — the LLM only proposes; merge (not the model) makes a memory valid
- Not a vector store / keyword scoring — duplicate detection is title/content matching at propose-time plus a model verdict in the background audit
- Not auto-expiring — nothing is retired on a timer; retirement always goes through a PR
