---
id: mem-t_bDMz6p
title: "OpenCode: a deny-all plugin agent has no tools/MCP/skills in its prompt, only AGENTS.md"
tags:
  - opencode
  - plugin
  - audit
  - architecture
author: unknown
source: migrated from legacy MEMORY.md
proposed_at: 2026-10-29
approved_at: 2026-10-29
---
Verified in OpenCode 1.18.29 source and with a live server probe.

A plugin's `config` hook receives the resolved Config and can add `config.agent[name]` (fields: prompt, mode, hidden, steps, permission, model). A prompt can then name that agent via `agent` in the message body.

Prompt composition for such an agent:
- `agent.prompt` REPLACES the provider prompt ("You are OpenCode…") — session/llm/request.ts uses agent.prompt when set.
- Tool schemas are filtered by agent+session permission in `resolveTools` (request.ts:208-214), so `permission: { "*": "deny" }` removes ALL tools, including MCP tools (which are otherwise added unconditionally in session/tools.ts).
- MCP instructions and the skills list are also permission-filtered and disappear.
- Global `~/.config/opencode/AGENTS.md` and the project AGENTS.md are ALWAYS injected; `instruction.system()` takes no agent argument and cannot be suppressed per session. The only bypasses are process-wide flags.

Measured on this machine: a default `build` session's first call is ~98K–166K input tokens; the same prompt under a deny-all, short-prompt agent is ~8.6K input tokens (AGENTS.md + env + task text), cost $0.0065 on deepseek/deepseek-v4-pro. Session IDs passed to `session.idle` and `experimental.chat.system.transform` let the plugin ignore its own throwaway sessions.
