---
title: Publish and review
layout: default
parent: Daily use
nav_order: 2
---

Ask the agent to publish the staged proposals. It can call `memory_publish`, which runs the local bot once per store. The bot uses a temporary Git worktree to create a branch and open a pull request for each proposal; it does not switch your current branch or modify your uncommitted work. **Each proposal opens its pull request in the repository its store belongs to**: a global proposal in your private memory repository, a project proposal in the project repository. A failure in one store never blocks the other.

You can also run the bot yourself from the project directory:

```bash
npx -p @chncaesar/opencode-plugin-memory opencode-memory-bot once
```

`once` processes whatever is staged and exits; `watch` keeps polling instead, every two seconds unless you pass `--interval <ms>`.

To publish the global store by hand, point the bot at the clone instead: add `--dir <global clone>`.

Review each pull request on GitHub. Check whether the proposed knowledge is correct, useful beyond the current task, and consistent with existing project instructions. **Merging the pull request is the approval step.** Until then, the proposal is not shared truth.

If publishing fails, the proposal remains staged for a later retry. A previously pushed branch can be recovered without creating a duplicate commit. If the bot reports a skipped retirement because its target is no longer active, the staged proposal remains and requires attention.
