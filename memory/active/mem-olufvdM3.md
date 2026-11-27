---
id: mem-olufvdM3
title: OpenCode 插件收录渠道：官方 ecosystem 页靠提 PR，awesome-opencode 有 star 门槛，opencode.im 第三方目录可自提
tags:
  - opencode
  - distribution
  - promotion
  - ecosystem
author: Jiachuan Zhu
source: memory_update
proposed_at: 2026-11-27T00:38:49.423Z
supersedes:
  - mem-od6N5eVj
---
推广 OpenCode 插件时，唯一官方列表是文档站的 ecosystem 页（`opencode.ai/docs/ecosystem`）。它靠提 PR 上架，不是自动收录、也不是表单；这一条**不要求 star 数**，随时可提，而且头部插件基本都在上面，是最强的单一曝光位。注意它服务的是 V1 文档：V2 文档没有对应的 ecosystem 页，页面标题会显示 `Ecosystem | OpenCode V1`。

`awesome-opencode/awesome-opencode`（约 1.1 万 star）是另一条渠道，但有硬门槛，不满足会被直接关 PR：仓库至少 25 star 且存在满 30 天、90 天内有提交、去重。收录方式是往 `data/plugins/` 加一个 YAML 条目（含 name / repo / tagline ≤120 字符 / description，并注明 V1 还是 V2 支持），README 是自动生成的、不要手改。

`opencode.im` 是**第三方**插件目录（独立于官方文档站，有分类 / 排行榜 / 对比页和自建提交入口 `/submit`，文案为 "Submit a plugin"）。分类里 `Memory & Context` 是记忆类插件的归属位。本插件的上架页是 `https://opencode.im/plugin/chncaesar-opencode-plugin-memory`，状态标为 "Recently active"。

opencode.im 的兼容性一栏不是它自己探测的，而是读包内声明：本插件显示 `OpenCode V2 — Author declared`、`OpenCode V1 — Unknown`。也就是说只声明 V2 的插件在 V1 一栏永远是 Unknown，这是声明缺失，不是收录失败，不要为此反复提交。

因此新插件（低 star）的可行路径是：先把门面修好 → 提官方 ecosystem PR（不看 star）→ 到 r/opencode 之类社区首发拿 star → 达标后再提 awesome 列表。别指望直接提 awesome 过审。

**对官方页的预期要放低**：生态页 PR 队列长期积压，实测同类"加一个插件"的 PR 合并耗时从当天到 17 天不等，且同时有十几条在排。提交的价值在于占位和露出，不是快速上线。

另有两个不可靠渠道，别浪费精力：`opencode.cafe` 各分类都显示 0 插件，疑似废弃；`opendock.net` 的提交页返回 402。GitHub 上 `anomalyco/opencode` 关闭了 Discussions，没有展示区。
