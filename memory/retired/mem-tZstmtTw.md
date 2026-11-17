---
id: mem-tZstmtTw
title: OpenCode 插件收录渠道：官方 ecosystem 页靠提 PR，awesome-opencode 硬门槛 25 star + 仓库满 30 天
tags:
  - opencode
  - distribution
  - promotion
  - ecosystem
author: Jiachuan Zhu
source: memory_propose
proposed_at: 2026-11-17T01:26:53.123Z
superseded_by: mem-od6N5eVj
retired_at: 2026-11-17T02:54:59.513Z
retired_reason: superseded
---
推广 OpenCode 插件时，唯一官方列表是文档站的 ecosystem 页（`opencode.ai/docs/ecosystem`，当前会跳到 V1 路径），靠提 PR 上架，不是自动收录、也不是表单；源文件在 `anomalyco/opencode` 仓库的 `packages/web/src/content/docs/ecosystem.mdx`。这一条不要求 star 数，随时可提，而且头部插件基本都在上面，是最强的单一曝光位。V2 文档目前没有对应的 ecosystem 页。

`awesome-opencode/awesome-opencode`（约 1.1 万 star）是另一条渠道，但有硬门槛，且不满足会被直接关 PR：仓库至少 25 star 且存在满 30 天、90 天内有提交、去重。收录方式是往 `data/plugins/` 加一个 YAML 条目（含 name / repo / tagline ≤120 字符 / description，并注明 V1 还是 V2 支持），README 是自动生成的、不要手改。

因此新插件（低 star）的可行路径是：先把门面修好 → 提官方 ecosystem PR（不看 star）→ 到 r/opencode 之类社区首发拿 star → 达标后再提 awesome 列表。别指望直接提 awesome 过审。

另有两个不可靠渠道，别浪费精力：`opencode.cafe` 各分类都显示 0 插件，疑似废弃；`opendock.net` 的提交页返回 402。GitHub 上 `anomalyco/opencode` 关闭了 Discussions，没有展示区。
