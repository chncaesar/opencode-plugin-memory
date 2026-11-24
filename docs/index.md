---
title: OpenCode Plugin Memory User Guide
---

# OpenCode Plugin Memory User Guide

Give OpenCode a way to remember useful knowledge across sessions — your own knowledge, which follows you into every repository, and knowledge that belongs to one repository — without letting an agent silently turn its own conclusions into shared rules.

Memory has two stores. **Global** memory is one private repository of yours, cloned on this machine and injected into every session. **Project** memory lives in a repository's own `memory/` folder and travels with it. In both cases an agent proposes an entry, a local bot opens a pull request, and a person reviews and merges it; only merged entries are active. Everything is Markdown in Git; no vector database or hosted memory service is required.

This guide covers version 0.7.0.

## Before you begin

You need:

- OpenCode 2.x. OpenCode 1.x is not supported.
- A Git repository with an `origin` remote that you can push to.
- The [GitHub CLI](https://cli.github.com/), authenticated with an account that can open pull requests.

The GitHub requirements apply when publishing proposals. Publishing pushes branches and opens pull requests; it does **not** merge them.

## 1. Install the plugin

To install the plugin in your global OpenCode configuration:

```bash
opencode plugin add @chncaesar/opencode-plugin-memory@latest
```

Alternatively, add it to the `plugins` array in your project or global `opencode.json`:

```json
{
  "plugins": ["@chncaesar/opencode-plugin-memory"]
}
```

### Configure the plugin

All options are optional. If you do not specify them, the plugin uses the defaults below. Put options inside the plugin entry, not at the top level of your OpenCode configuration. Restart OpenCode after editing them.

For example, this OpenCode 2.x configuration keeps an operation log, checks memories at most once every 30 minutes, and uses a smaller audit batch:

```json
{
  "plugins": [
    {
      "package": "@chncaesar/opencode-plugin-memory",
      "options": {
        "enableLog": true,
        "auditIntervalMinutes": 30,
        "auditBatchChars": 100000
      }
    }
  ]
}
```

If you already have other OpenCode settings or plugins, add the entry to your existing configuration instead of replacing it.

| Option | Default | Purpose |
| --- | --- | --- |
| `maxSummaryChars` | `10000` | Maximum characters in the injected index of memory titles. The separate memory-writing policy is not included in this limit. |
| `enableLog` | `true` | Write an operation log to `.memory/plugin.log`. Set to `false` to disable it. |
| `staleDays` | `90` | Age in days after which `memory_review` lists an active memory as aging. This is informational; it does not retire memories. |
| `backgroundAudit` | `true` | Enable the model-assisted audit after sessions become idle. Set to `false` to disable it; proposals and manual review still work. |
| `auditIntervalMinutes` | `1` | Minimum number of minutes between background audit attempts. Increase it to run audits less frequently. |
| `auditBatchChars` | `400000` | Maximum characters of memory text per audit batch. Lower it when the audit model has a smaller context window. |
| `auditModel` | Host default | Select the host model for audits as `providerID/modelID`. Ignored when `auditProvider` is set. |
| `auditProvider` | Not configured | Use a separate OpenAI-compatible endpoint and credentials for audits instead of the host's model call. See [Use a separate audit provider](#use-a-separate-audit-provider). |
| `globalMemoryEnabled` | `true` | Enable the global store. Set to `false` to keep memory inside each project, as earlier versions did. |
| `globalMemoryPath` | `~/.local/share/opencode/memory` | Where the global store is cloned on this machine. A leading `~` is expanded. |
| `defaultScope` | `global` | Store used when a proposal does not name one. Falls back to `project` when the global store is unavailable, so a missing clone never blocks a proposal. |
| `globalIndexShare` | `0.7` | Share of `maxSummaryChars` the global index may use. The project index keeps at least the rest reserved, so a large global store cannot push project entries out of the prompt. Unused budget is shared back. |

An audit interval is a minimum, not a promise that an audit will run on a timer: the plugin also checks conditions such as whether the active memories have changed. Batch size is measured in characters, not tokens. The default assumes a large context window; leave room for the prompt and response when choosing a smaller value. Individual memories are not split, and related entries in different batches can still be missed.

For example, to turn off automatic audits in OpenCode 2.x while keeping the rest of the plugin available:

```json
{
  "plugins": [
    {
      "package": "@chncaesar/opencode-plugin-memory",
      "options": { "backgroundAudit": false }
    }
  ]
}
```

To select a configured host model instead, set `"auditModel": "providerID/modelID"` in `options`, replacing both parts with an actual provider and model available in your OpenCode setup.

#### Use a separate audit provider

The audit can call an OpenAI-compatible endpoint with its own credentials instead of using the host's model call. This can help if the host's account credential is rejected by the audit endpoint, or if you want to separate audit usage from the main model's quota.

For OpenCode 2.x, add an `auditProvider` object to `options`:

```json
{
  "plugins": [
    {
      "package": "@chncaesar/opencode-plugin-memory",
      "options": {
        "auditProvider": {
          "baseUrl": "https://api.example.com",
          "apiKey": "{env:MEMORY_AUDIT_API_KEY}",
          "model": "your-model"
        }
      }
    }
  ]
}
```

Replace the endpoint and model with your provider's values, set the environment variable, and restart OpenCode. The endpoint must support OpenAI-compatible chat completions. A `{file:path}` key reference is also supported. Keep actual API keys out of committed configuration.

The `auditProvider` fields are:

| Field | Required | Purpose |
| --- | --- | --- |
| `baseUrl` | Yes | Provider's base URL. Use the base appropriate for its OpenAI-compatible chat completions API, such as a URL ending in `/v1` if required by that provider. |
| `apiKey` | Yes | API key, or a reference such as `{env:MEMORY_AUDIT_API_KEY}` or `{file:~/.secrets/audit-key}`. |
| `model` | Yes | Model identifier accepted by that provider. |
| `headers` | No | Object of additional HTTP request headers, for providers that require them. |

For example, add `"headers": { "X-Provider-Header": "value" }` inside `auditProvider` only when your provider requires it. A custom `Authorization` header replaces the bearer authorization generated from `apiKey`; it is not added alongside it. Treat authentication headers as secrets and do not commit them.

An explicit `auditProvider` takes precedence over `auditModel`. If the provider configuration is incomplete, the audit reports an error rather than silently switching credentials. For a model with a smaller context window, lower `auditBatchChars`.

### Set up the global store

Global memory is optional but recommended: without it, knowledge learned in one checkout never reaches another, and every proposal opens a pull request in whichever repository you happen to be working in.

1. Create a **private** repository for your own memories.
2. Clone it to `globalMemoryPath` (default `~/.local/share/opencode/memory`). It is a working copy of that repository, so keep it outside any project directory.
3. Give it the same layout as a project store: `memory/active/`, `memory/retired/`, and a `.gitignore` containing `.memory/` — that folder holds local staging, the bot lock and the log, which must never be committed.

If the folder is missing, nothing breaks: the plugin says so in the prompt and writes proposals to the project store instead. A clone can be added at any time; the next session picks it up without a restart.

Proposals default to the global store. Use `scope: "project"` when the rule would be wrong, or pointless, in a different repository — its architecture, module names, business definitions, or a convention its contributors must follow. Everything else (tool and API behaviour, infrastructure, personal preferences, review rules) is global.

The two indexes share one character budget. The global store may use up to `globalIndexShare` of it, while the project store keeps at least the remainder reserved; budget one side does not need is available to the other. A truncated section says so and points at `memory_read`.

## 2. Propose a memory

Work in your project as usual. When you encounter a lesson that would help another session, you can ask:

> Remember that reports must identify inventory records by both product and batch.

The agent may also propose durable knowledge without an explicit request, for example after discovering a project convention or receiving a correction about how to work. A good memory captures an actionable lesson, not a transcript of one task.

The proposal is written to a local staging area. **It is not active yet**, and other checkouts do not receive it. Ask the agent to show you the proposal if you want to inspect it before publishing.

Prefer project instructions for mandatory, explicitly maintained rules. Avoid storing secrets, one-off task details, or facts that are already documented and easy to look up.

## 3. Publish and review

Ask the agent to publish the staged proposals. It can call `memory_publish`, which runs the local bot once per store. The bot uses a temporary Git worktree to create a branch and open a pull request for each proposal; it does not switch your current branch or modify your uncommitted work. **Each proposal opens its pull request in the repository its store belongs to**: a global proposal in your private memory repository, a project proposal in the project repository. A failure in one store never blocks the other.

You can also run the bot yourself from the project directory:

```bash
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot once
```

To publish the global store by hand, point the bot at the clone instead: add `--dir <global clone>`.

Review each pull request on GitHub. Check whether the proposed knowledge is correct, useful beyond the current task, and consistent with existing project instructions. **Merging the pull request is the approval step.** Until then, the proposal is not shared truth.

If publishing fails, the proposal remains staged for a later retry. A previously pushed branch can be recovered without creating a duplicate commit. If the bot reports a skipped retirement because its target is no longer active, the staged proposal remains and requires attention.

## 4. Use a memory in a later session

After the pull request is merged, update the working branch where you want to use the memory so it contains the merged change. Global memories need one pull in the global store's clone; project memories need the pull in that project. In a new session, the plugin derives an index of active memory titles and IDs from both stores. When a title is relevant, the agent can read the full entry.

Only the index is injected by default, not every memory body. The index has a configurable size limit; if it is full, the agent can use `memory_review` or `memory_read` to inspect entries beyond the injected subset.

For example, after the inventory lesson is merged and pulled into a checkout, a later session working on another inventory report can find and read the lesson before choosing how to identify records.

## 5. Update or retire a memory

When a project convention changes, tell the agent what changed and ask it to update the old memory. An update stages a replacement that supersedes the old entry; it does not modify active memory immediately.

When a memory is wrong or no longer useful, ask the agent to retire it. That, too, is a proposal. Review and merge its pull request to make the change active. Retired entries are kept in the repository for history rather than silently erased.

Ask the agent to review the memory collection when you want an overview of active, pending, or aging entries. Age is informational: a memory is not retired merely because it is old.

## 6. When a rule becomes a feature

A memory is for what the artifact cannot say. Before accepting a proposal, ask one forward-looking question: once this rule is done, will the code, the tests or the design doc state it?

- If it already does — the screen behaves that way, the schema enforces it, the design doc says it — close the proposal. Two copies of one rule drift apart at the next redesign.
- If it will, but it is not built yet, the rule belongs to the task list or the design doc, not to memory. Writing it down now guarantees a duplicate once it lands.
- If no artifact will ever state it — what a field really means, why an obvious approach is dangerous, a boundary that forbids something — that is exactly what memory is for.

When a remembered rule does get built, retire the memory and say why. The retirement reason `implemented` records that the rule graduated into the artifact; the pull request shows it as graduated so a reviewer sees the memory is leaving because the code took over, not because the rule stopped being true.

## Background audit

By default, the plugin can audit active memories after a session becomes idle. It looks for possible duplicates, refinements, and contradictions. Audit findings become retirement proposals, not automatic changes; a person still reviews and merges the resulting pull requests.

The audit can split a large collection into overlapping batches. This keeps individual model calls bounded, but it can miss a relationship between entries placed in different batches. Treat the findings as review suggestions, not a complete or infallible analysis.

The audit uses the host's model by default. To send audits to a separate OpenAI-compatible endpoint with its own credentials, configure `auditProvider` as described in [Use a separate audit provider](#use-a-separate-audit-provider).

## Where the information lives

| Store | Location | Purpose |
| --- | --- | --- |
| Global | Your private repository, cloned at `globalMemoryPath` | `.memory/staging/` holds local, Git-ignored proposals; `memory/active/` holds merged entries injected into every session; `memory/retired/` keeps history |
| Project | The current repository | The same three folders, scoped to this repository and shared with whoever has it |

The prompt index is derived from active memories in both stores; there is no generated index file to commit or CI job to wait for. Your checkout still needs the merged changes before it can see them.

## Troubleshooting

**The agent proposed a memory, but a later session cannot see it.** Check that its pull request was merged, then update the later session's working branch and start a new session. A staged proposal or an open pull request is not an active memory.

**A proposal did not produce a pull request.** Confirm the repository has an `origin` remote, your account can push to it, and GitHub CLI is installed and authenticated. The bot reports failures and retains failed proposals for retry.

**The audit reports a missing API key.** Check the configured provider, environment variable or key file, and restart OpenCode after updating configuration. A partially configured provider does not fall back silently.

**A later session sees only some of my memories, or says global memory is not configured.** A missing global clone degrades to project-only memory instead of failing. Check that `globalMemoryPath` exists and is a clone of your private memory repository; proposals already staged in the global store stay there. If both stores have entries but one section is truncated, raise `maxSummaryChars` — the two sections share it.

**The audit fails on a large memory collection.** Check that the audit model works and supports the request size. Reduce `auditBatchChars` if its context window is smaller than the default assumes. Batching limits the size of individual requests but may miss cross-batch relationships.

**I want to inspect or change memories directly.** Ask the agent to read or review them, or inspect the repository's Markdown files. For changes that should become shared knowledge, use the proposal and pull-request workflow so the review boundary remains clear.

## Further reading

- [Project repository and full configuration reference](https://github.com/chncaesar/opencode-plugin-memory)
- [Report an issue](https://github.com/chncaesar/opencode-plugin-memory/issues)
