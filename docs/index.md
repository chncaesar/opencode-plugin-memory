---
title: OpenCode Plugin Memory User Guide
---

# OpenCode Plugin Memory User Guide

Give OpenCode a way to remember useful project knowledge across sessions, without letting an agent silently turn its own conclusions into shared rules.

The plugin is project-scoped. An agent proposes a memory, a local bot opens a pull request, and a person reviews and merges it. Only merged memories are active. They live in your repository as Markdown; no vector database or hosted memory service is required.

This guide covers version 0.6.0.

## Before you begin

You need:

- OpenCode 1.x or 2.x.
- A Git repository with an `origin` remote that you can push to.
- The [GitHub CLI](https://cli.github.com/), authenticated with an account that can open pull requests.

The GitHub requirements apply when publishing proposals. Publishing pushes branches and opens pull requests; it does **not** merge them.

## 1. Install the plugin

### OpenCode 2.x

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

### OpenCode 1.x

Add the package to the singular `plugin` array in your OpenCode configuration:

```json
{
  "plugin": ["@chncaesar/opencode-plugin-memory"]
}
```

Restart OpenCode after changing the configuration. The same plugin package supports both versions, but their configuration keys are different.

## 2. Propose a memory

Work in your project as usual. When you encounter a lesson that would help another session, you can ask:

> Remember that reports must identify inventory records by both product and batch.

The agent may also propose durable knowledge without an explicit request, for example after discovering a project convention or receiving a correction about how to work. A good memory captures an actionable lesson, not a transcript of one task.

The proposal is written to a local staging area. **It is not active yet**, and other checkouts do not receive it. Ask the agent to show you the proposal if you want to inspect it before publishing.

Prefer project instructions for mandatory, explicitly maintained rules. Avoid storing secrets, one-off task details, or facts that are already documented and easy to look up.

## 3. Publish and review

Ask the agent to publish the staged proposals. It can call `memory_publish`, which runs the local bot once. The bot uses a temporary Git worktree to create a branch and open a pull request for each proposal; it does not switch your current branch or modify your uncommitted work.

You can also run the bot yourself from the project directory:

```bash
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot once
```

Review each pull request on GitHub. Check whether the proposed knowledge is correct, useful beyond the current task, and consistent with existing project instructions. **Merging the pull request is the approval step.** Until then, the proposal is not shared truth.

If publishing fails, the proposal remains staged for a later retry. A previously pushed branch can be recovered without creating a duplicate commit. If the bot reports a skipped retirement because its target is no longer active, the staged proposal remains and requires attention.

## 4. Use a memory in a later session

After the pull request is merged, update the working branch where you want to use the memory so it contains the merged change. In a new session, the plugin derives an index of active memory titles and IDs from that checkout. When a title is relevant, the agent can read the full entry.

Only the index is injected by default, not every memory body. The index has a configurable size limit; if it is full, the agent can use `memory_review` or `memory_read` to inspect entries beyond the injected subset.

For example, after the inventory lesson is merged and pulled into a checkout, a later session working on another inventory report can find and read the lesson before choosing how to identify records.

## 5. Update or retire a memory

When a project convention changes, tell the agent what changed and ask it to update the old memory. An update stages a replacement that supersedes the old entry; it does not modify active memory immediately.

When a memory is wrong or no longer useful, ask the agent to retire it. That, too, is a proposal. Review and merge its pull request to make the change active. Retired entries are kept in the repository for history rather than silently erased.

Ask the agent to review the memory collection when you want an overview of active, pending, or aging entries. Age is informational: a memory is not retired merely because it is old.

## Background audit

By default, the plugin can audit active memories after a session becomes idle. It looks for possible duplicates, refinements, and contradictions. Audit findings become retirement proposals, not automatic changes; a person still reviews and merges the resulting pull requests.

The audit can split a large collection into overlapping batches. This keeps individual model calls bounded, but it can miss a relationship between entries placed in different batches. Treat the findings as review suggestions, not a complete or infallible analysis.

### Use a separate audit provider

Version 0.6 allows the audit to call an OpenAI-compatible endpoint with its own credentials. This can help if the host's account credential is rejected by the audit endpoint, or if you want to separate audit usage from the main model's quota.

For OpenCode 2.x:

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

For OpenCode 1.x, options use a different shape:

```json
{
  "plugin": [
    [
      "@chncaesar/opencode-plugin-memory",
      {
        "auditProvider": {
          "baseUrl": "https://api.example.com",
          "apiKey": "{env:MEMORY_AUDIT_API_KEY}",
          "model": "your-model"
        }
      }
    ]
  ]
}
```

An explicit `auditProvider` takes precedence over `auditModel`. If the provider configuration is incomplete, the audit reports an error rather than silently switching credentials. For a model with a smaller context window, lower `auditBatchChars`; see the [configuration reference](https://github.com/chncaesar/opencode-plugin-memory#configuration) for all options.

## Where the information lives

| Location | Purpose |
| --- | --- |
| `.memory/staging/` | Local, Git-ignored proposals awaiting publication |
| `memory/active/` | Merged memories available to sessions in this checkout |
| `memory/retired/` | Retired memories and their history |

The prompt index is derived from active memories; there is no generated index file to commit or CI job to wait for. Your checkout still needs the merged changes before it can see them.

## Troubleshooting

**The agent proposed a memory, but a later session cannot see it.** Check that its pull request was merged, then update the later session's working branch and start a new session. A staged proposal or an open pull request is not an active memory.

**A proposal did not produce a pull request.** Confirm the repository has an `origin` remote, your account can push to it, and GitHub CLI is installed and authenticated. The bot reports failures and retains failed proposals for retry.

**The audit reports a missing API key.** Check the configured provider, environment variable or key file, and restart OpenCode after updating configuration. A partially configured provider does not fall back silently.

**The audit fails on a large memory collection.** Check that the audit model works and supports the request size. Reduce `auditBatchChars` if its context window is smaller than the default assumes. Batching limits the size of individual requests but may miss cross-batch relationships.

**I want to inspect or change memories directly.** Ask the agent to read or review them, or inspect the repository's Markdown files. For changes that should become shared knowledge, use the proposal and pull-request workflow so the review boundary remains clear.

## Further reading

- [Project repository and full configuration reference](https://github.com/chncaesar/opencode-plugin-memory)
- [Report an issue](https://github.com/chncaesar/opencode-plugin-memory/issues)
