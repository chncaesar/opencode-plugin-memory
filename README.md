# opencode-plugin-memory

[简体中文](README.zh-CN.md) | **English**

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

PR-gated, project-scoped persistent memory for [OpenCode](https://opencode.ai). The LLM proposes durable knowledge; a human approves it by merging a pull request before it becomes shared truth. No cloud dependency, no vector database.

New to the plugin? Start with the [English user guide](docs/index.md).

## How it works

- Six tools (`memory_propose`, `memory_update`, `memory_delete`, `memory_read`, `memory_review`, `memory_publish`) are registered with OpenCode and available to the LLM during every session.
- The LLM **never writes shared truth directly**. It only writes a proposal file into a machine-local, git-ignored `.memory/staging/` folder.
- A local **bot** (a small CLI you run on your machine) watches staging, branches, commits each proposal into `memory/active/`, and opens a pull request.
- A **human** reviews the PR against a checklist and merges it. Merge is the only approval.
- Every session derives an index from `memory/active/` and injects it into the system prompt: titles plus IDs only, never full bodies. Full bodies load lazily through `memory_read`, so the store can grow without bloating each request.

A memory is not valid until it is merged. Proposed, wrong, or harmful memories never silently become shared truth.

## Storage layout

State is positional — the folder a file lives in is its status:

```
.memory/staging/mem-*.md    machine-local drop folder, git-ignored, the agent writes here
memory/active/mem-*.md      merged truth; the only memories injected into context
memory/retired/mem-*.md     removed memories, with reason and provenance
```

There is no index file: the prompt index is derived from `memory/active/` at session start, so it can never drift from what was merged.

Each file is self-describing via YAML frontmatter (`id`, `title`, `author`, `source`, `proposed_at`, `approved_at`, `approved_by`, `supersedes` / `superseded_by`, `retired_at`, `retired_reason`, `related_pr`, and — for staged files — `intent`). IDs are random and collision-free (`mem-` + 8 base64url chars), so multiple branches can add memories concurrently.

## Installation

The plugin registers both the OpenCode 2.x `setup` hook and the 1.x `server` hook, so one package works on either. The configuration key differs between the two, so check your version first.

### OpenCode 2.x

Installs the package and adds it to your config in one step:

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

Or declare it by hand in the `plugins` (**plural**) array of `opencode.json` / `opencode.jsonc`:

```jsonc
"plugins": ["@chncaesar/opencode-plugin-memory"]

// from a local clone or directory
"plugins": ["./opencode-plugin-memory"]

// with options (all optional; see Configuration below for the full list)
"plugins": [
  {
    "package": "@chncaesar/opencode-plugin-memory",
    "options": {
      "maxSummaryChars": 10000,
      "auditIntervalMinutes": 2,
      // Give the audit its own endpoint and key instead of borrowing the host's
      // account credential. Any OpenAI-compatible provider works.
      "auditProvider": {
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "{file:~/.secrets/opencode/deepseek-api-key}",
        "model": "deepseek-flash"
      }
    }
  }
]
```

A local build takes the same object form, with the path in `package`:

```jsonc
"plugins": [
  {
    "package": "./opencode-plugin-memory",
    "options": { "maxSummaryChars": 10000 }
  }
]
```

### OpenCode 1.x

The key is singular (`plugin`) and the array holds plain module names. OpenCode installs npm plugins itself at startup, so nothing else is needed:

```jsonc
"plugin": ["@chncaesar/opencode-plugin-memory"]

// with options (all optional; same names as the 2.x object form)
"plugin": [
  [
    "@chncaesar/opencode-plugin-memory",
    {
      "maxSummaryChars": 10000,
      "auditIntervalMinutes": 30,
      "auditProvider": {
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "{file:~/.secrets/opencode/deepseek-api-key}",
        "model": "deepseek-flash"
      }
    }
  ]
]
```

Restart OpenCode afterwards: plugins are loaded per server process.

## The bot

The LLM can run the bot itself through the argument-less `memory_publish` tool. It needs no user approval because it only opens PRs (the merge is the gate), and all git work happens in a throwaway `git worktree`, so your checkout, branch and uncommitted files are never touched. A lock file (`.memory/bot.lock`) keeps a `watch` daemon and `memory_publish` from running at once.

The bot is the only component that holds repository credentials and runs git. It is a local daemon/CLI, not a GitHub Action — an Action runs remotely and can never see a local, git-ignored staging folder. It uses the `gh` CLI (already authenticated) to open PRs.

```bash
npx opencode-memory-bot once                                  # process staged proposals once, then exit
npx opencode-memory-bot watch                                 # poll staging forever (default every 2s)
npx opencode-memory-bot watch --interval 10000 --dir <path>   # different poll interval / project
```

Or from a clone: `node dist/bot.js once`. The bot:

- reads each staged file's `intent`;
- `propose` → branches `memory/<id>`, commits the file into `memory/active/` (moving any `supersedes` targets to `memory/retired/` with `superseded_by`), pushes, opens a PR, then removes the staged file;
- `retire` → branches `memory/retire/<id>-<timestamp>` (the add branch for that id is normally still around), moves `memory/active/<id>` to `memory/retired/` with the reason, pushes, opens a PR, then removes the staged file.

Each proposal ends in one of four outcomes, reported as counters at the end of a run:

- **promoted** — branch created, commit made, PR opened, staged file removed;
- **recovered** — the branch was already on the remote (an earlier run pushed it and stopped before the PR): the bot finds the existing PR, or opens it, and removes the staged file. No second commit, no duplicate branch;
- **skipped** — a `retire` proposal whose target is no longer active, so there was nothing to move. The staged file is deliberately left in place, which means it is retried and reported on every later run until someone deletes it;
- **failed** — git or `gh` refused; the staged file stays for the next run, and `once` exits non-zero. A `propose` that would change no file also lands here, because git refuses an empty commit.

`regenerate` is accepted as a no-op for older CI jobs that still call it. The bot never spins: it walks the staging folder on a fixed interval and leaves failures where they are.

## Progressive context

Only the index (one `[mem-XXXX] Title` line per active memory) enters the system prompt, capped by `maxSummaryChars`. When the cap is hit the model gets a subset plus a notice, and can call `memory_read` to load a specific body or `memory_review` to list everything. Nothing derived is committed, so there is no CI step and no generated file to keep in sync.

## Configuration

- `maxSummaryChars` (number, default `10000`) — max characters used by the injected index of titles. The fixed writing policy is added separately.
- `enableLog` (boolean, default `true`) — write an operation log to `.memory/plugin.log`.
- `staleDays` (number, default `90`) — active memories older than this are listed as "aging" in `memory_review`. Informational only; nothing is retired on an age threshold.
- `backgroundAudit` (boolean, default `true`) — run the model-judged semantic audit after sessions go idle: it compares every active memory and reports duplicate / refinement / contradiction findings, each of which becomes a retirement proposal (turned into a PR by the bot). Where the model call happens depends on the host and the options: a restricted `memory-audit` agent on 1.x, the host's own stateless text generation on 2.x, or the explicit endpoint below when `auditProvider` is set.
- `auditIntervalMinutes` (number, default `1`) — minimum minutes between two background audits.
- `auditBatchChars` (number, default `400000`) — max characters of memory text per audit model call. The default assumes a ~1M-token model and about one token per character (Chinese); lower it if your audit model has a smaller context window, since an over-long prompt makes the audit fail. A larger store is split into batches of related entries, with a 3-entry overlap between batches; a memory is never cut in two, and a pair that lands in different batches can still be missed. Example: `"auditBatchChars": 100000` in the plugin options.
- `auditModel` (string, V2 host only) — model for the audit, as `"providerID/modelID"`. Without it the host default is used (the V1 audit agent prefers `small_model`). Ignored when `auditProvider` is set.
- `auditProvider` (object, default `none`) — let the audit call a provider directly, with a key it reads itself, instead of asking the host to generate the text. The endpoint must be OpenAI-compatible (`/chat/completions`):

  ```jsonc
  "auditProvider": {
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "{file:~/.secrets/opencode/deepseek-api-key}",
    "model": "deepseek-flash"
  }
  ```

  `apiKey` may be a literal, `{file:path}` or `{env:NAME}` — the host expands those references before the plugin sees the options, and the plugin resolves them again only when a host passes one through verbatim. A missing key file therefore arrives as an **empty string**, which the plugin rejects with `"auditProvider" is missing apiKey` rather than silently calling the provider unauthenticated. An optional `headers` object adds request headers, for endpoints that need more than a bearer token; it is merged case-insensitively, so a custom `authorization` replaces the bearer token instead of being sent alongside it. Use this when the host relays model calls through an inference gateway that rejects an account token (PAT or OAuth login) with `HTTP 400 … Personal Access Tokens are not supported for this endpoint` — a credential-type rejection, not a quota error — or simply to keep the audit off the main model's quota. Unlike the other options, a *partial* `auditProvider` fails loudly: the audit reports the missing field instead of quietly going back to the host's credential. It takes precedence over `auditModel` on both hosts.

## When does the LLM propose a memory?

The system prompt and tool description guide the LLM to call `memory_propose` when:

- the user says "remember this" / "save this";
- a reusable coding rule or project convention is discovered;
- a recurring bug pattern is fixed and the lesson should persist;
- the user corrects how the LLM communicates, reasons, edits, tests, or collaborates;
- the user confirms a non-obvious approach worked and should be repeated;
- a memory needs correcting, replacing, or removing because it went stale or conflicts.

Unscoped corrections and preferences are durable by default — the user does not need to say "remember this". Instructions limited to the current answer, task, or file are not proposed. Duplicates are checked against active and staged memories before proposing.

## Migration from the legacy single-file store

On first run, the plugin migrates the legacy `.opencode/memory/MEMORY.md` (and `.agents/memory/MEMORY.md`) — the old `Active`/`Archived` + `MEM-NNN` + `nextSeq` format — into one file per memory under `memory/active/` and `memory/retired/`. A `memory/.migration.json` sidecar maps old IDs to new ones so `superseded_by` links resolve. Migration is idempotent, the legacy file is left in place as a backup, and it never blocks startup.

## Development

```bash
npm install
npm run typecheck   # type-check only, no emit
npm run build       # compile to dist/
npm test            # compile + run unit tests (Node built-in runner)
```

## Design notes

- **PR-gated** — a memory is valid only after merge; nothing proposed is trusted before a human approves it.
- **Credential-free agent** — the agent never holds repo credentials and never runs git; it only writes a local file.
- **Progressive loading** — the prompt sees a compact index of titles; full bodies load on demand.
- **Memory validity is independent of code reversibility** — a memory survives its own review lifecycle and is never bundled into a code change.
- **No automatic deletion** — nothing is retired on a timer; retirement always goes through a PR.
- **Zod version** — uses `tool.schema` from `@opencode-ai/plugin` (zod 4), never `import { z } from "zod"` directly.
