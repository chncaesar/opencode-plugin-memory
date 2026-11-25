---
title: Where the information lives
layout: default
parent: Reference
nav_order: 1
---

| Store | Location | Purpose |
| --- | --- | --- |
| Global | Your private repository, cloned at `globalMemoryPath` | `.memory/staging/` holds local, Git-ignored proposals; `memory/active/` holds merged entries injected into every session; `memory/retired/` keeps history |
| Project | The current repository | The same three folders, scoped to this repository and shared with whoever has it |

The prompt index is derived from active memories in both stores; there is no generated index file to commit or CI job to wait for. Your checkout still needs the merged changes before it can see them.
