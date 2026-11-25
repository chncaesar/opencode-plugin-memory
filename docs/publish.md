---
title: Review and merge
layout: default
parent: Daily use
nav_order: 3
---

The agent proposes a memory and opens its pull request automatically. You do not need to ask it to publish or approve a separate publishing step. **Your only approval is merging the pull request.**

Each pull request opens in the repository its memory belongs to: a global memory in your private memory repository, a project memory in the project repository. Publishing one store never blocks the other, and it does not switch your current branch or modify your uncommitted work.

If automatic publishing fails, you can retry from the project directory:

```bash
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot once
```

`once` processes whatever is staged and exits; `watch` keeps polling instead, every two seconds unless you pass `--interval <ms>`.

To publish the global store by hand, point the bot at the clone instead: add `--dir <global clone>`.

Review each pull request on GitHub. Check whether the proposed knowledge is correct, useful beyond the current task, and consistent with existing project instructions. **Merging the pull request is the approval step.** Until then, the proposal is not shared truth.

If publishing fails, the proposal remains staged for a later retry. A previously pushed branch can be recovered without creating a duplicate commit. If the bot reports a skipped retirement because its target is no longer active, the staged proposal remains and requires attention.
