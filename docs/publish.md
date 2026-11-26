---
title: Review and merge
layout: default
parent: Daily use
nav_order: 3
---

The agent proposes a memory, and publishing needs no instruction from you: whenever proposals are waiting, the plugin tells the agent they have no pull request yet, and the agent opens them. **Your only approval is merging the pull request.**

Each pull request opens in the repository its memory belongs to: a global memory in your private memory repository, a project memory in the project repository. Publishing one store never blocks the other, and it does not switch your current branch or modify your uncommitted work.

If publishing fails, you can retry from the project directory (the bot resolves that repository's plugin-managed project store automatically):

```bash
npx -p @chncaesar/opencode-plugin-memory@latest opencode-memory-bot once
```

`once` processes whatever is staged and exits; `watch` keeps polling instead, every two seconds unless you pass `--interval <ms>`.

To publish a specific store root by hand — such as the global store clone — pass `--dir <store root>`.

Review each pull request on GitHub. Check whether the proposed knowledge is correct, useful beyond the current task, and consistent with existing project instructions. **Merging the pull request is the approval step.** Until then, the proposal is not shared truth.

If publishing fails, the proposal remains staged for a later retry. A previously pushed branch can be recovered without creating a duplicate commit. If the bot reports a skipped retirement because its target is no longer active, the staged proposal remains and requires attention.
