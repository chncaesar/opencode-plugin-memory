---
title: Use a memory in a later session
layout: default
parent: Daily use
nav_order: 3
---

After the pull request is merged, update the working branch where you want to use the memory so it contains the merged change. Global memories need one pull in the global store's clone; project memories need the pull in that project. In a new session, the plugin derives an index of active memory titles and IDs from both stores. When a title is relevant, the agent can read the full entry.

Only the index is injected by default, not every memory body. The index has a configurable size limit; if it is full, the agent can use `memory_review` or `memory_read` to inspect entries beyond the injected subset.

For example, after the inventory lesson is merged and pulled into a checkout, a later session working on another inventory report can find and read the lesson before choosing how to identify records.
