---
title: Where the information lives
layout: default
parent: Reference
nav_order: 1
---

| Store | Location | Purpose |
| --- | --- | --- |
| Global | Your private repository, cloned at `globalMemoryPath` | `.memory/staging/` holds local, Git-ignored proposals; `memory/active/` holds merged entries injected into every session; `memory/retired/` keeps history |
| Project | A plugin-managed checkout under `~/.local/share/opencode/project-memory/` | Mirrors the project repository's `memory/active/` and `memory/retired/` from its remote default branch, and holds that project's `.memory/` staging, audit state, and log outside your working copy |

The prompt index is derived from active memories in both stores; there is no generated index file to commit or CI job to wait for. Merged project memories are refreshed automatically into the plugin-managed checkout without modifying your branch or uncommitted work; your own project checkout updates its `memory/` files whenever you normally pull. The global store still uses your local clone at `globalMemoryPath`.
