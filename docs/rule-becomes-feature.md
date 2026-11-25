---
title: When a rule becomes a feature
layout: default
parent: Maintenance
nav_order: 2
---

A memory is for what the artifact cannot say. Before accepting a proposal, ask one forward-looking question: once this rule is done, will the code, the tests or the design doc state it?

- If it already does — the screen behaves that way, the schema enforces it, the design doc says it — close the proposal. Two copies of one rule drift apart at the next redesign.
- If it will, but it is not built yet, the rule belongs to the task list or the design doc, not to memory. Writing it down now guarantees a duplicate once it lands.
- If no artifact will ever state it — what a field really means, why an obvious approach is dangerous, a boundary that forbids something — that is exactly what memory is for.

When the agent builds a remembered rule — or notices during the session that it has already been built — it automatically proposes retiring that memory with the reason `implemented` and opens the pull request. You do not need to request retirement or publishing as a separate step; you only review and merge the pull request.

The pull request marks the memory as graduated, so a reviewer sees that the code took over rather than assuming the rule stopped being true. The agent cannot notice work that happens outside its sessions, so mention the completed feature the next time you work with it if no retirement pull request appeared.
