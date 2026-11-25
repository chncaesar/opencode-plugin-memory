---
title: Overview
layout: default
nav_order: 1
---

Give OpenCode a way to remember useful knowledge across sessions — your own knowledge, which follows you into every repository, and knowledge that belongs to one repository — without letting an agent silently turn its own conclusions into shared rules.

Memory has two stores. **Global** memory is one private repository of yours, cloned on this machine and injected into every session. **Project** memory is committed in a repository's own `memory/` folder and read through a separate plugin-managed checkout that refreshes from the remote default branch without touching your working directory. In both cases an agent proposes an entry, a local bot opens a pull request, and a person reviews and merges it; only merged entries are active. Everything is Markdown in Git; no vector database or hosted memory service is required.

## Merge is the only approval

The agent never writes shared truth. It can only drop a proposal file into a machine-local, git-ignored staging folder inside the target store, and a memory is not valid until a human merges the pull request. Proposed, wrong or harmful content therefore never silently becomes shared truth.

## Where to start

- [Install the plugin]({% link install.md %}), then [configure it]({% link configure.md %}) if the defaults do not suit you.
- [Set up a global store]({% link global-store.md %}) if you want knowledge to follow you across repositories. It is optional.
- [Tell the agent what is worth remembering]({% link propose.md %}). It proposes the memory and opens the pull request automatically; you only [review and merge it]({% link publish.md %}).

This guide covers version 0.7.0.
