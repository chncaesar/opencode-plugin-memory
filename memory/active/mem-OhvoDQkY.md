---
id: mem-OhvoDQkY
title: "Release notes speak to prospective users: one fact per section, plain language, no cross-section repeats"
tags:
  - feedback
  - release-notes
  - writing
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-25T02:02:15.777Z
---
How to write release notes in this repository (the input a reader uses to decide whether to install):

- **Audience is a prospective user, not the author.** Describe what they can now do and what will bite them. Never "updated tests" / "refactored X" / how it was implemented.
- **Each of the three sections owns one job.** What you can do now = capabilities only. Upgrading = only actions the user must take. Known limitations = only consequences they will meet. A fact belongs in exactly one section: a capability restated under Upgrading, or a limitation that repeats an advertised fix, is a defect, not thoroughness.
- **No configuration key names, no internal vocabulary** (index, worktree, batch, share), no module or file names. Say what happens in the workflow; let the linked user guide carry the switches, defaults and folder layout.
- **Consolidating a scattered section:** fold related items under one bold lead-in that states the behaviour, keep the lead verb-first, and drop any item whose content the lead already implies.

Evidence: the v0.7.0 notes were rejected three times in a row — 12 scattered bullets ("太多太散，整合一下"), Upgrading bullets that repeated What you can do now ("这些和第一段重复啊"), then technical phrasing ("release notes 不是给作者看的，是给潜在用户看的…说人话"). The approved version was 6 + 3 + 4 bullets with no fact stated twice.
