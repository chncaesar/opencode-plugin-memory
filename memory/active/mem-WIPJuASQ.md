---
id: mem-WIPJuASQ
title: Make memory files visible to the polling bot only after the full write succeeds
tags:
  - storage
  - bot
  - data-integrity
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-19T08:04:31.773Z
---
When adding a memory producer, use the shared memory writer so a complete file is written to an exclusive temporary path in the same directory, then renamed to its final mem-*.md name. The bot and other readers ignore temporary names. A partial body can still form a valid memory document, so parsing success is not a write-completion signal. Atomic visibility does not authorize deleting a newer replacement of a proposal the bot already read.
