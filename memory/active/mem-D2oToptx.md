---
id: mem-D2oToptx
title: WebFetch 必须走 subagent，避免 context 膨胀
tags:
  - workflow
  - context
  - performance
author: unknown
source: migrated from legacy MEMORY.md
proposed_at: 2026-09-07
approved_at: 2026-09-07
---
当 webfetch 的目的是提取信息（文档查阅、页面内容分析、爬取任意 URL），必须用 Task subagent 做，不在主 session 里直接调用 WebFetch 工具。

原因：webfetch 返回的原始 HTML 平均 1-3 万字符，直接进入主 session 的 messages 数组，严重膨胀 context。subagent 有独立 context，主 session 只收到精炼摘要（通常几百字）。

例外：用户明确提供 URL 且只需要快速核实单一事实（如确认某个 API 字段），可以在主 session 里直接调用。
