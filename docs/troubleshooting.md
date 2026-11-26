---
title: Troubleshooting
layout: default
parent: Reference
nav_order: 2
---

**The agent proposed a memory, but a later session cannot see it.** Check that its pull request was merged into the repository's default branch. A staged proposal or an open pull request is not an active memory. Project memories refresh automatically from the remote default branch into the plugin-managed project store; global memories fast-forward automatically in `globalMemoryPath` when the clone is on its default branch with no local tracked edits.

**A proposal did not produce a pull request.** Confirm the repository has an `origin` remote, your account can push to it, and GitHub CLI is installed and authenticated. The bot reports failures and retains failed proposals for retry.

**The bot says nothing is staged, although the agent proposed something.** You are most likely running an old copy of the bot, which looks for proposals inside your project folder instead of the isolated project store. Use the `npx` form on the [install page]({% link install.md %}#install-the-bot-optional), or [upgrade the bot]({% link install.md %}#upgrading) so it matches the plugin's version.

**I upgraded the plugin, and the bot still behaves like the old version.** They are two separate installations: the plugin is the copy OpenCode loads from its own cache, while the bot is a global install whose only job is to put `opencode-memory-bot` on your `PATH` — upgrading the plugin never touches it. Upgrade both, in that order, as described in [Upgrading]({% link install.md %}#upgrading); or use the `npx` form, which always resolves the current version.

**The audit reports a missing API key.** Check the configured provider, environment variable or key file, and restart OpenCode after updating configuration. A partially configured provider does not fall back silently.

**A later session sees only some of my memories, or says global memory is not configured.** A missing global clone degrades to project-only memory instead of failing. Check that `globalMemoryPath` exists and is a clone of your private memory repository; proposals already staged in the global store stay there. If both stores have entries but one section is truncated, raise `maxSummaryChars` — the two sections share it.

**The audit fails on a large memory collection.** Check that the audit model works and supports the request size. Reduce `auditBatchChars` if its context window is smaller than the default assumes. Batching limits the size of individual requests but may miss cross-batch relationships.

**I want to inspect or change memories directly.** Ask the agent to read or review them, or inspect the Markdown files in the store. Because project memories are read from the plugin-managed checkout rather than your working branch, your project checkout will show new files only after you pull normally. For changes that should become shared knowledge, use the proposal and pull-request workflow so the review boundary remains clear.
