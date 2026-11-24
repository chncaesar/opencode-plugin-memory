---
id: mem-wFJ9WWdv
title: Do not infer OpenCode host support from the presence of a legacy plugin entry point
tags:
  - opencode
  - compatibility
  - docs
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-19T07:34:27.319Z
supersedes:
  - mem-K_WkIN1I
---
When documenting this plugin's installation or preparing release notes, use the support statement in the user guide. A legacy entry point does not prove that older host loaders can load it; for example, OpenCode 1.0.224 called module exports directly instead of reading the server property from the exported object. If support is ever expanded, validate the actual host loader before advertising it.
