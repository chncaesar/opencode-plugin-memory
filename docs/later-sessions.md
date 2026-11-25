---
title: Use a memory in a later session
layout: default
parent: Daily use
nav_order: 4
---

After a project-memory pull request is merged into the remote default branch, the plugin refreshes its own isolated project-memory checkout automatically. You do not need to pull or rebase your working branch first, and uncommitted changes in your checkout are not touched. For the global store, pull merged changes in your local clone at `globalMemoryPath` before starting the session that should use them. The next session derives an index of active memory titles and IDs from both stores. When a title is relevant, the agent can read the full entry.

Only the index is injected by default, not every memory body. The index has a configurable size limit; if it is full, the agent can use `memory_review` or `memory_read` to inspect entries beyond the injected subset.

For example, after the inventory lesson is merged into the project repository, a later session working on another inventory report can find and read the lesson automatically — even while your current branch still has local edits.
