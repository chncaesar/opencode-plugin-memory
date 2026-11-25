---
title: Set up a global store
layout: default
parent: Getting started
nav_order: 4
---

Global memory is optional but recommended: without it, knowledge learned in one checkout never reaches another, and every proposal opens a pull request in whichever repository you happen to be working in.

1. Create a **private** repository for your own memories.
2. Clone it to `globalMemoryPath` (default `~/.local/share/opencode/memory`). It is a working copy of that repository, so keep it outside any project directory.
3. Give it the same layout as a project store: `memory/active/`, `memory/retired/`, and a `.gitignore` containing `.memory/` — that folder holds local staging, the bot lock and the log, which must never be committed.

If the folder is missing, nothing breaks: the plugin says so in the prompt and writes proposals to the project store instead. A clone can be added at any time; the next session picks it up without a restart.

Proposals default to the global store once that clone exists. Use `scope: "project"` when the rule would be wrong, or pointless, in a different repository — its architecture, module names, business definitions, or a convention its contributors must follow. Everything else (tool and API behaviour, infrastructure, personal preferences, review rules) is global.

The two indexes share one character budget. The global store may use up to `globalIndexShare` of it, while the project store keeps at least the remainder reserved; budget one side does not need is available to the other. A truncated section says so and points at `memory_read`.
