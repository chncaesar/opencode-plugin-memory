---
title: Update or retire a memory
layout: default
parent: Maintenance
nav_order: 1
---

When a project convention changes, tell the agent what changed and ask it to update the old memory. An update stages a replacement that supersedes the old entry; it does not modify active memory immediately. The replacement stays in the store that holds the original — a proposal that targets an entry in the other store is refused with instructions — so updating never moves knowledge between stores.

When a memory is wrong or no longer useful, ask the agent to retire it. That, too, is a proposal. Review and merge its pull request to make the change active. Retired entries are kept in the repository for history rather than silently erased.

Ask the agent to review the memory collection when you want an overview of active, pending, or aging entries. Age is informational: a memory is not retired merely because it is old.
