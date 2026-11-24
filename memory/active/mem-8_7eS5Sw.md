---
id: mem-8_7eS5Sw
title: "Several sessions edit this checkout at once: re-check HEAD and re-read a file before rewriting it wholesale"
tags:
  - workflow
  - git
  - opencode
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-24T09:33:23.213Z
---
The user often runs more than one OpenCode session (and terminal work) against the same working tree, so a commit can land *while* you are mid-edit. A wholesale file rewrite built from an earlier read silently drops whatever arrived in between: during the two-store work, a rebase brought in commit 4e98af2 (new retirement reason `implemented`) between the read and the rewrite, and the rewrite erased it. The test suite only caught it because tests asserted the new behaviour.

Rules:
- Before rewriting a whole file, re-read it (or at least `git log -1` + `git diff HEAD -- <file>`) rather than trusting a read from earlier in the turn.
- After any wholesale rewrite, review `git diff HEAD -- <file>` for removed lines that are not yours; a pure-addition diff is the safe shape.
- If HEAD moved mid-turn, re-run the full suite before claiming success — a passing subset does not prove the other session's change survived.
- Keep changes uncommitted until the user asks; commit messages stay separate from the other session's work.
