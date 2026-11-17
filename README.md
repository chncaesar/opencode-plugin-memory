# opencode-plugin-memory

[简体中文](README.zh-CN.md) | **English**

[![npm version](https://img.shields.io/npm/v/@chncaesar/opencode-plugin-memory)](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory)

PR-gated, project-scoped persistent memory for [OpenCode](https://opencode.ai). The LLM proposes durable knowledge; a human approves it by merging a pull request before it becomes shared truth. No cloud dependency, no vector database.

> **Full user guide (English): <https://chncaesar.github.io/opencode-plugin-memory/>**
> Step-by-step usage, every configuration option, background-audit setup, and troubleshooting live there. This README covers only the essentials.

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

There is no index file: the prompt index is derived from `memory/active/` at session start, so it can never drift from what was merged. Each file is self-describing through YAML frontmatter, and IDs are random and collision-free (`mem-` + 8 base64url chars), so multiple branches can add memories concurrently.

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
```

### OpenCode 1.x

The key is singular (`plugin`) and the array holds plain module names. OpenCode installs npm plugins itself at startup, so nothing else is needed:

```jsonc
"plugin": ["@chncaesar/opencode-plugin-memory"]
```

Restart OpenCode afterwards: plugins are loaded per server process.

Options go inside the plugin entry — an `options` object on 2.x, a two-element `[package, options]` array on 1.x. See [Configuration](#configuration).

## Configuration

All options are optional; without them the defaults apply. Put them inside the plugin entry, not at the top level of your OpenCode configuration, and restart OpenCode after editing.

The available options are `maxSummaryChars`, `enableLog`, `staleDays`, `backgroundAudit`, `auditIntervalMinutes`, `auditBatchChars`, `auditModel`, and `auditProvider`. Defaults, behavior, and full examples live in the user guide's [configuration section](https://chncaesar.github.io/opencode-plugin-memory/#configure-the-plugin), with a separate page on [using an audit provider of its own](https://chncaesar.github.io/opencode-plugin-memory/#use-a-separate-audit-provider).

## The bot

The LLM can run the bot itself through the argument-less `memory_publish` tool. It needs no user approval because it only opens PRs (the merge is the gate), and all git work happens in a throwaway `git worktree`, so your checkout, branch and uncommitted files are never touched. A lock file (`.memory/bot.lock`) keeps a `watch` daemon and `memory_publish` from running at once.

```bash
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot once    # process staged proposals once, then exit
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot watch   # poll staging forever (default every 2s)
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot watch --interval 10000 --dir <path>
```

The bot is the only component that holds repository credentials and runs git. It is a local daemon/CLI, not a GitHub Action — an Action runs remotely and can never see a local, git-ignored staging folder. It uses the authenticated `gh` CLI to open PRs. Per-proposal outcomes, retry behavior, and failure reporting are documented in the guide's [publish and review step](https://chncaesar.github.io/opencode-plugin-memory/#3-publish-and-review).

## When does the LLM propose a memory?

The system prompt and tool description guide the LLM to call `memory_propose` when:

- the user says "remember this" / "save this";
- a reusable coding rule, project convention, or recurring bug lesson is discovered or confirmed;
- the user corrects how the LLM communicates, reasons, edits, tests, or collaborates;
- a memory needs correcting, replacing, or removing because it went stale or conflicts.

Unscoped corrections and preferences are durable by default — the user does not need to say "remember this". Instructions limited to the current answer, task, or file are not proposed, and duplicates are checked against active and staged memories before proposing.

## Migration from the legacy single-file store

On first run, the plugin migrates the legacy `.opencode/memory/MEMORY.md` (and `.agents/memory/MEMORY.md`) — the old `Active`/`Archived` + `MEM-NNN` + `nextSeq` format — into one file per memory under `memory/active/` and `memory/retired/`. A `memory/.migration.json` sidecar maps old IDs to new ones so `superseded_by` links resolve. Migration is idempotent, the legacy file is left in place as a backup, and it never blocks startup.

## Development

```bash
npm install
npm run typecheck   # type-check only, no emit
npm run build       # compile to dist/
npm test            # compile + run unit tests (Node built-in runner)
```

Contributions are welcome through GitHub issues and pull requests. Run `npm test` before opening a PR; the design constraints below are the ones reviewers check.

## Design notes

- **PR-gated** — a memory is valid only after merge; nothing proposed is trusted before a human approves it.
- **Credential-free agent** — the agent never holds repo credentials and never runs git; it only writes a local file.
- **Progressive loading** — the prompt sees a compact index of titles; full bodies load on demand.
- **Memory validity is independent of code reversibility** — a memory survives its own review lifecycle and is never bundled into a code change.
- **No automatic deletion** — nothing is retired on a timer; retirement always goes through a PR.
- **Zod version** — uses `tool.schema` from `@opencode-ai/plugin` (zod 4), never `import { z } from "zod"` directly.

## Further reading

- [User guide](https://chncaesar.github.io/opencode-plugin-memory/) (English)
- [Project repository](https://github.com/chncaesar/opencode-plugin-memory)
- [Report an issue](https://github.com/chncaesar/opencode-plugin-memory/issues)
