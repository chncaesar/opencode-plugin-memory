---
title: Troubleshooting
layout: default
parent: Reference
nav_order: 2
---

**The agent proposed a memory, but a later session cannot see it.** Check that its pull request was merged, then update the later session's working branch and start a new session. A staged proposal or an open pull request is not an active memory.

**A proposal did not produce a pull request.** Confirm the repository has an `origin` remote, your account can push to it, and GitHub CLI is installed and authenticated. The bot reports failures and retains failed proposals for retry.

**The audit reports a missing API key.** Check the configured provider, environment variable or key file, and restart OpenCode after updating configuration. A partially configured provider does not fall back silently.

**A later session sees only some of my memories, or says global memory is not configured.** A missing global clone degrades to project-only memory instead of failing. Check that `globalMemoryPath` exists and is a clone of your private memory repository; proposals already staged in the global store stay there. If both stores have entries but one section is truncated, raise `maxSummaryChars` — the two sections share it.

**The audit fails on a large memory collection.** Check that the audit model works and supports the request size. Reduce `auditBatchChars` if its context window is smaller than the default assumes. Batching limits the size of individual requests but may miss cross-batch relationships.

**I want to inspect or change memories directly.** Ask the agent to read or review them, or inspect the repository's Markdown files. For changes that should become shared knowledge, use the proposal and pull-request workflow so the review boundary remains clear.
