---
id: mem-_u1n72I7
title: The memory bot may clean only worktrees it can prove it created; honor Git removal failures
tags:
  - bot
  - git
  - data-safety
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-19T07:16:37.678Z
---
When changing the memory bot's worktree lifecycle, keep cleanup limited to a worktree whose exact location was recorded when the bot created it. Do not infer ownership from a name prefix or assume a per-project lock protects all linked checkouts. If Git refuses removal, preserve the directory and log the location for manual cleanup; never fall back to recursive deletion. Use isolated Git fixtures to cover a prefixed primary checkout, a prefixed unrelated linked checkout, and a locked bot-owned worktree.
