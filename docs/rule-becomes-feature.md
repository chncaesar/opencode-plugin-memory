---
title: What should become a memory?
layout: default
parent: Daily use
nav_order: 1
---

Use memory for knowledge that will still be useful later but will not be obvious from the product, code or documentation.

## Good memories

- A business term whose real meaning is not obvious, such as a field labelled “Version” that actually stores the product model.
- A trap and why the obvious approach is dangerous, such as a deployment method that can include uncommitted work.
- A personal preference or review rule that should follow you into future sessions.
- A boundary that says what must never happen, even though no screen or test can show it.

## Do not save

- Behaviour the screen, code, tests or user guide already makes clear.
- A feature request or task that has not been built yet. Keep it in the task or design document instead.
- Current facts that are cheap to look up again, such as a deployed version, a row count or a configuration value.
- Secrets, credentials or one-off details from the current task.

If the agent skips a memory because the finished feature will state the rule itself, that is intentional: keeping the same rule in two places lets them disagree after the next redesign.

## When code takes over

When the agent builds a remembered rule — or notices during the session that it has already been built — it proposes retiring that memory and opens the pull request. You do not need to request retirement or publishing as a separate step.

Check one thing in the pull request: **does the product, code, test or documentation now guarantee the rule?** If yes, merge it. If not, close it and keep the memory.

The agent cannot notice work completed outside its sessions. If no retirement pull request appears, mention the completed feature the next time you work with it.
