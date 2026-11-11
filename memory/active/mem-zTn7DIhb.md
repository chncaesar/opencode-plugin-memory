---
id: mem-zTn7DIhb
title: OpenCode 2.x: a deny-all permission agent gets no tools, MCP, or skills — only AGENTS.md
tags:
  - opencode
  - plugin
  - architecture
  - tokens
  - v2
author: Jiachuan Zhu
source: memory_update
proposed_at: 2026-11-11T09:12:11.089Z
supersedes:
  - mem-t_bDMz6p
---
Applies to OpenCode 2.x. Verified against the 2.2.7 source; the 1.x field names are dead and will fail silently.

## How

1. A plugin takes the agent editor through the **agent hook** (not the 1.x `config` hook) and can add, update, or remove agents. Configure the throwaway agent with:
   - `system`: a very short replacement prompt
   - `permissions`: `[{ action: "*", resource: "*", effect: "deny" }]`
   - `hidden: true`, and `mode` set to `primary` or `subagent` as needed
2. Point a session at that agent (sessions carry an agent field), then run the one-off task through it.

## Why it works (real code paths in 2.2.7)

- Prompt assembly: when `agent.system` is set it replaces the built-in provider prompt entirely; otherwise the default is used.
- Tool set: filtered by the merged agent + session permission rules. Anything landing on a deny rule never reaches the tool list the model sees — **MCP tools included**, and the code-mode executor goes too. The model cannot even see what it could call.
- MCP server instructions and the skills list: loaded with the same permission ruleset, so deny-all removes them as well.
- AGENTS.md (global + project): **always injected**. Assembly has no knowledge of the agent, and there is no per-session or per-agent switch to turn it off.

## Measured effect

For the same task, a one-off session dropped from 98K–166K input tokens on a normal session to about 8,600 on the throwaway agent (measured on 1.x; not re-measured on 2.x, treat as magnitude only).

## 1.x → 2.x field map (old names fail silently, no error)

| 1.x | 2.x |
|---|---|
| plugin `config` hook | agent hook |
| `agent.prompt` | `agent.system` |
| `permission` | `permissions` |
